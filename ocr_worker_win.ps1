# ocr_worker_win.ps1 —— 用 **Windows 自带 OCR** 实现与 ocr_worker.py 完全相同的协议。
#
# 为什么要有这一份：PaddleOCR 运行时约 1GB，而 Windows 10/11 自带 OCR 引擎
# （模型在 C:\\Windows\\OCR\\<语言>，中文约 2.3MB，随语言包已在系统里）**零下载**。
# 精度不如 PaddleOCR，尤其是图纸和复杂排版，但"能立刻用上"比"要先下 1GB"重要得多。
# 所以：装了 PaddleOCR 就用它（准），没装就退回这里（有）。
#
# 协议（与 ocr_worker.py 一致，Go 侧因此只需要改"启动哪个程序"）：
#   stdin  一行：{"image":路径,"rotation":0|90|180|270,"extraRotation":0|90|180|270,"width":可见宽,"height":可见高}
#   stdout 一行：{"ok":true,"data":{"width":..,"height":..,"runs":[...],"seconds":..,"model":"Windows OCR"}}
#
# 注意：**本文件必须保存为 UTF-8 with BOM**。PowerShell 5.1 读没有 BOM 的 .ps1
# 会按 ANSI/GBK 解析，中文一多就解析失败——office2pdf.ps1 就是这么崩过一次的。

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
# 输入也要设成 UTF-8：请求里的路径可能含中文（例如 "H:\PDF软件\..."），
# 只设 OutputEncoding 的话，读进来的路径会是乱码，然后以"找不到文件"的形式失败。
[Console]::InputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT 类型必须用 `[类型, 契约, ContentType=WindowsRuntime]` 这种写法解析。
# 简写成 [Windows.Media.Ocr.OcrEngine] 会得到 "Unable to find type"——
# 这是 PowerShell 5.1 解析 WinRT 的固定要求（踩过一次，别再改回去）。
$script:OcrEngineT   = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$script:LanguageT    = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
$script:StorageFileT = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$script:AccessModeT  = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$script:StreamT      = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$script:DecoderT     = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$script:BitmapT      = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
$script:OcrResultT   = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]

# WinRT 的异步调用在 PowerShell 5.1 里要靠 AsTask 手工等
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]

function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    return $task.Result
}

# 系统里可用的 OCR 语言。优先中文，其次用户配置语言，最后随便挑一个能用起来的。
function Get-OcrEngine {
    foreach ($tag in @('zh-Hans-CN', 'zh-Hans', 'zh-CN')) {
        try {
            $lang = New-Object $script:LanguageT $tag
            $e = $script:OcrEngineT::TryCreateFromLanguage($lang)
            if ($e) { return $e }
        } catch { }
    }
    $e = $script:OcrEngineT::TryCreateFromUserProfileLanguages()
    if ($e) { return $e }
    $langs = $script:OcrEngineT::AvailableRecognizerLanguages
    if ($langs -and $langs.Count -gt 0) {
        return $script:OcrEngineT::TryCreateFromLanguage($langs[0])
    }
    return $null
}

# 按 90 度的整数倍旋转图片（extraRotation 是"为了摆正页面"额外转的角度）
function Rotate-Image([System.Drawing.Bitmap]$bmp, [int]$deg) {
    $deg = (($deg % 360) + 360) % 360
    if ($deg -eq 0) { return $bmp }
    if ($deg -eq 180) { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
    elseif ($deg -eq 90) { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate90FlipNone) }
    elseif ($deg -eq 270) { $bmp.RotateFlip([System.Drawing.RotateFlipType]::Rotate270FlipNone) }
    return $bmp
}

# 与 ocr_worker.py 的 unrotate 完全一致：把"显示坐标系"里的框换算回页面坐标系。
# 两边必须一致，否则同一个页面用两种引擎识别出来的框会落在不同位置。
function Unrotate($x, $y, $w, $h, [int]$angle) {
    switch ($angle) {
        90 { return @{ x = $y; y = 1 - $x - $w; w = $h; h = $w } }
        180 { return @{ x = 1 - $x - $w; y = 1 - $y - $h; w = $w; h = $h } }
        270 { return @{ x = 1 - $y - $h; y = $x; w = $h; h = $w } }
        default { return @{ x = $x; y = $y; w = $w; h = $h } }
    }
}

function Invoke-Ocr($request) {
    $started = Get-Date
    $engine = Get-OcrEngine
    if (-not $engine) {
        throw '这台机器没有可用的 Windows OCR 语言包（设置 > 时间和语言 > 语言，添加中文并勾选"光学字符识别"）'
    }

    $imagePath = $request.image
    $extra = [int]$request.extraRotation % 360

    # 需要额外旋转时，先用 GDI+ 转好再交给 WinRT（WinRT 的 BitmapTransform 也能做，
    # 但那要重编码一遍，这里直接在位图上转更直接）
    $work = $imagePath
    $tmp = $null
    if ($extra -ne 0) {
        Add-Type -AssemblyName System.Drawing
        $bmp = [System.Drawing.Bitmap]::FromFile($imagePath)
        $bmp = Rotate-Image $bmp $extra
        $tmp = [System.IO.Path]::Combine([System.IO.Path]::GetTempPath(), [System.Guid]::NewGuid().ToString('N') + '.png')
        $bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        $work = $tmp
    }

    try {
        $file = Await ($script:StorageFileT::GetFileFromPathAsync($work)) ($script:StorageFileT)
        $stream = Await ($file.OpenAsync($script:AccessModeT::Read)) ($script:StreamT)
        $decoder = Await ($script:DecoderT::CreateAsync($stream)) ($script:DecoderT)
        $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ($script:BitmapT)
        $result = Await ($engine.RecognizeAsync($bitmap)) ($script:OcrResultT)

        $imgW = [double]$decoder.PixelWidth
        $imgH = [double]$decoder.PixelHeight
        $angle = [int]$request.rotation % 360
        $visibleH = if ($angle % 180 -ne 0) { [double]$request.width } else { [double]$request.height }

        $runs = New-Object System.Collections.ArrayList
        foreach ($line in $result.Lines) {
            # Windows OCR 按"行"给结果，但不给整行的外框，所以把该行各词的外框并起来。
            # 用整行而不是逐词：前端是按"一段可编辑文字"来对待的，逐词会碎成一片。
            $minX = [double]::MaxValue; $minY = [double]::MaxValue
            $maxX = 0.0; $maxY = 0.0
            $sb = New-Object System.Text.StringBuilder
            foreach ($word in $line.Words) {
                $r = $word.BoundingRect
                if ($r.X -lt $minX) { $minX = $r.X }
                if ($r.Y -lt $minY) { $minY = $r.Y }
                if (($r.X + $r.Width) -gt $maxX) { $maxX = $r.X + $r.Width }
                if (($r.Y + $r.Height) -gt $maxY) { $maxY = $r.Y + $r.Height }
                # Windows OCR 把**每个汉字当成一个独立的词**，直接用空格连接会得到
                # "扫 描 件 识 别"。所以只在"前一个字符和后一个词的首字符都是 ASCII
                # 字母/数字"时才补空格——这样英文单词之间仍有空格，中文则连成一片。
                if ($sb.Length -gt 0) {
                    $prev = $sb[$sb.Length - 1]
                    $next = if ($word.Text.Length -gt 0) { $word.Text[0] } else { ' ' }
                    $prevAscii = ([int][char]$prev -lt 128)
                    $nextAscii = ([int][char]$next -lt 128)
                    if ($prevAscii -and $nextAscii -and -not [char]::IsWhiteSpace($prev) -and -not [char]::IsWhiteSpace($next)) {
                        [void]$sb.Append(' ')
                    }
                }
                [void]$sb.Append($word.Text)
            }
            $text = $sb.ToString().Trim()
            if (-not $text) { continue }

            $x = $minX / $imgW; $y = $minY / $imgH
            $w = ($maxX - $minX) / $imgW; $h = ($maxY - $minY) / $imgH
            $rect = Unrotate $x $y $w $h $angle
            $fontSize = [Math]::Max(4, [Math]::Min(144, (($maxY - $minY) / $imgH) * $visibleH * 0.75))

            [void]$runs.Add([ordered]@{
                    id         = "ocr-$($runs.Count)"
                    text       = $text
                    rect       = [ordered]@{ x = $rect.x; y = $rect.y; w = $rect.w; h = $rect.h }
                    fontSize   = [Math]::Round($fontSize, 2)
                    font       = 'auto'
                    color      = '#000000'
                    angle      = $angle
                    source     = 'ocr'
                    # Windows OCR 不提供置信度（PaddleOCR 才给）。这里给 0 表示"未知"，
                    # 前端据此不显示那个百分比——编一个数字出来才是真的误导。
                    confidence = 0
                })
        }

        $seconds = [Math]::Round(((Get-Date) - $started).TotalSeconds, 3)
        return [ordered]@{
            width   = $request.width
            height  = $request.height
            runs    = $runs
            seconds = $seconds
            model   = "Windows OCR ($($engine.RecognizerLanguage.LanguageTag))"
        }
    } finally {
        if ($tmp -and (Test-Path $tmp)) { Remove-Item $tmp -Force -ErrorAction SilentlyContinue }
    }
}

# 主循环：读一行、答一行，和 ocr_worker.py 一样
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if (-not $line.Trim()) { continue }
    try {
        $request = $line | ConvertFrom-Json
        $data = Invoke-Ocr $request
        $payload = [ordered]@{ ok = $true; data = $data }
    } catch {
        # 把内层异常也带出来：WinRT 的异步失败只报一句
        # "One or more errors occurred"，真正的原因全在 InnerException 里
        $msg = $_.Exception.Message
        $inner = $_.Exception.InnerException
        while ($inner) { $msg += ' <- ' + $inner.Message; $inner = $inner.InnerException }
        $payload = [ordered]@{ ok = $false; error = $msg }
    }
    $json = $payload | ConvertTo-Json -Depth 12 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}
