# office2pdf.ps1 -- convert Word / PowerPoint / Excel documents to PDF via COM.
#
# IMPORTANT: this file MUST stay UTF-8 **with BOM**.
# Windows PowerShell 5.1 reads .ps1 as ANSI (GBK on a Chinese system) when there is
# no BOM, so the Chinese comments below get mis-decoded and break the parser -- the
# symptom was $procName silently ending up empty and Get-Process failing with
# "Cannot validate argument on parameter 'Name'". Do not strip the BOM.
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File office2pdf.ps1 -Src <in> -Dst <out.pdf>
#
# Exit codes: 0 = ok, 2 = unsupported extension, 3 = Office not available, 1 = other failure.

param(
    [Parameter(Mandatory = $true)][string]$Src,
    [Parameter(Mandatory = $true)][string]$Dst,
    [string]$Kind = ''
)

$ErrorActionPreference = 'Stop'

# 输出统一用 UTF-8：控制台默认是 GBK，Go 侧按 UTF-8 读回来会变成乱码，
# 那样报错信息就没法看了。
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
    $OutputEncoding = [Console]::OutputEncoding
} catch { }

function Fail([int]$code, [string]$msg) {
    [Console]::Error.WriteLine($msg)
    exit $code
}

if (-not (Test-Path -LiteralPath $Src)) { Fail 1 "source not found: $Src" }
$Src = (Resolve-Path -LiteralPath $Src).Path
$DstDir = Split-Path -Parent $Dst
if ($DstDir -and -not (Test-Path -LiteralPath $DstDir)) {
    New-Item -ItemType Directory -Force -Path $DstDir | Out-Null
}
# COM SaveAs wants an absolute path; a relative one gets resolved against Office's
# own working directory, which silently writes somewhere else.
$Dst = [System.IO.Path]::GetFullPath($Dst)
if (Test-Path -LiteralPath $Dst) { Remove-Item -LiteralPath $Dst -Force }

$ext = [System.IO.Path]::GetExtension($Src).ToLowerInvariant()
if (-not $Kind) {
    switch -Regex ($ext) {
        '^\.(docx?|rtf|odt|txt|docm)$' { $Kind = 'word' }
        '^\.(pptx?|odp|pptm)$' { $Kind = 'ppt' }
        '^\.(xlsx?|xlsm|xlsb|ods|csv)$' { $Kind = 'excel' }
        default { Fail 2 "unsupported extension: $ext" }
    }
}

# An app that was ALREADY running must not be quit by us: Word/Excel COM are
# single-instance, so New-Object would hand back the user's own session and
# Quit() would close their open documents.
function Test-Running([string]$progId) {
    try {
        [Runtime.InteropServices.Marshal]::GetActiveObject($progId) | Out-Null
        return $true
    } catch {
        return $false
    }
}

function Release($obj) {
    if ($null -ne $obj) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($obj) } catch { }
    }
}

$alreadyRunning = Test-Running $(switch ($Kind) {
        'word' { 'Word.Application' }
        'ppt' { 'PowerPoint.Application' }
        'excel' { 'Excel.Application' }
    })

# Office 自动化很容易留下后台进程（Excel 尤其顽固）：Quit 往往因为还有引用而不生效。
# 所以先记下"开工前已有哪些同类进程"，收尾时只清理**这期间新出现**的那些——
# 用户自己开的实例绝不会被误杀。
$procName = @{ word = 'WINWORD'; ppt = 'POWERPNT'; excel = 'EXCEL' }[$Kind]
$beforeIds = @(Get-Process -Name $procName -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)

function ReapSpawned {
    if ($alreadyRunning) { return }
    Start-Sleep -Milliseconds 400
    Get-Process -Name $procName -ErrorAction SilentlyContinue |
        Where-Object { $beforeIds -notcontains $_.Id -and $_.MainWindowHandle -eq 0 } |
        ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue } catch { } }
}

function Cleanup($app, $docObj) {
    if ($null -ne $docObj) {
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($docObj) } catch { }
    }
    if ($null -ne $app) {
        if (-not $alreadyRunning) { try { $app.Quit() } catch { } }
        try { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app) } catch { }
    }
    # 两轮 GC 是标准做法：第一轮把 RCW 变成可回收，第二轮才真正释放
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    [GC]::Collect(); [GC]::WaitForPendingFinalizers()
    ReapSpawned
}

try {
    switch ($Kind) {
        'word' {
            $app = New-Object -ComObject Word.Application
            $app.Visible = $false
            $app.DisplayAlerts = 0
            $doc = $null
            try {
                # Open(FileName, ConfirmConversions, ReadOnly)
                $doc = $app.Documents.Open($Src, $false, $true)
                # 17 = wdExportFormatPDF
                $doc.ExportAsFixedFormat($Dst, 17)
                try { $doc.Close(0) } catch { }
            } finally {
                Cleanup $app $doc
            }
        }
        'ppt' {
            $app = New-Object -ComObject PowerPoint.Application
            $pres = $null
            try {
                # Open(FileName, ReadOnly, Untitled, WithWindow)
                # msoFalse(=0) 在 PowerPoint 2016 上会直接报错，只能用 msoTrue；
                # 窗口会在转换期间短暂出现，这是 PowerPoint 自动化的固有限制。
                $pres = $app.Presentations.Open($Src, $true, $false, $true)
                # 32 = ppSaveAsPDF
                $pres.SaveAs($Dst, 32)
                try { $pres.Close() } catch { }
            } finally {
                Cleanup $app $pres
            }
        }
        'excel' {
            $app = New-Object -ComObject Excel.Application
            $app.Visible = $false
            $app.DisplayAlerts = $false
            $wb = $null
            try {
                # Open(FileName, UpdateLinks, ReadOnly)
                $wb = $app.Workbooks.Open($Src, 0, $true)
                # 0 = xlTypePDF
                $wb.ExportAsFixedFormat(0, $Dst)
                try { $wb.Close($false) } catch { }
            } finally {
                Cleanup $app $wb
            }
        }
        default { Fail 2 "unsupported kind: $Kind" }
    }
} catch {
    Fail 1 $_.Exception.Message
}

if (-not (Test-Path -LiteralPath $Dst)) { Fail 1 "conversion produced no output" }
$len = (Get-Item -LiteralPath $Dst).Length
if ($len -le 0) { Fail 1 "conversion produced an empty file" }

exit 0
