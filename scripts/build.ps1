# 一键重建 PDF Guru。
#
# 为什么要有这个脚本：
#   改了 thirdparty/*.py 之后必须重新冻结 pdf.exe，否则程序里跑的还是旧逻辑——
#   而这一步极易遗漏（构建看起来"成功了"，但行为没变，非常难排查）。
#   已经因为漏掉它浪费过一次排查时间，故固化成脚本。
#
# 用法：
#   pwsh -File scripts/build.ps1              # 全量：冻结 + 构建 + 组装
#   pwsh -File scripts/build.ps1 -SkipFreeze  # 只改了前端/Go 时用，省时间
#
# 环境变量（都有默认值，按需覆盖）：
#   PDFGURU_VENV   Python 虚拟环境目录（内含 Scripts\python.exe）
#   GOROOT          Go 安装目录
#   GOBIN          wails 可执行文件所在目录
param(
    [switch]$SkipFreeze,
    [string]$Venv = $env:PDFGURU_VENV
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$goRoot = if ($env:GOROOT) { $env:GOROOT } else { 'H:\PDF软件\tools\go' }
$goBin = if ($env:GOBIN) { $env:GOBIN } else { 'H:\PDF软件\tools\gopath\bin' }
if (-not $Venv) { $Venv = 'H:\PDF软件\tools\venv' }

$python = Join-Path $Venv 'Scripts\python.exe'
$wails = Join-Path $goBin 'wails.exe'
$binDir = Join-Path $repo 'build\bin'

Write-Output "仓库:   $repo"
Write-Output "Python: $python"
Write-Output "wails:  $wails"

foreach ($p in @($python, $wails)) {
    if (-not (Test-Path $p)) { throw "找不到必需的可执行文件: $p" }
}

$env:GOROOT = $goRoot
$env:GOPATH = if ($env:GOPATH) { $env:GOPATH } else { 'H:\PDF软件\tools\gopath' }
$env:GOBIN = $goBin
if (-not $env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }
$env:PATH = "$goRoot\bin;$goBin;$env:PATH"

# 1) 冻结 Python 侧：pdf.py -> pdf.exe
#
# 这里**刻意不加 -F（onefile）**。onefile 每次启动都要把 ~46MB 解包到临时目录，
# 实测每次调用固定开销 ~1.35 秒，而实际工作往往只有几十毫秒——
# 拖一张图片要跑 4 次进程，用户就要等 5 秒多。改成 onedir 后同一命令降到 ~0.37 秒。
# 代价是产物变成一个文件夹（pdf.exe + _internal/），两者必须放在一起。
if (-not $SkipFreeze) {
    Write-Output "`n=== [1/3] 冻结 pdf.exe（onedir 模式，启动快 3~4 倍）==="
    Push-Location (Join-Path $repo 'thirdparty')
    try {
        & $python -m PyInstaller -w pdf.py --distpath dist --workpath build --noconfirm 2>&1 |
            Select-Object -Last 2
        if ($LASTEXITCODE -ne 0) { throw "PyInstaller 失败" }
    } finally {
        Pop-Location
    }
} else {
    Write-Output "`n=== [1/3] 跳过冻结（-SkipFreeze）==="
}

# 2) 构建前端 + Go（wails 会先生成绑定，再构建前端，最后编译）
Write-Output "`n=== [2/3] wails build ==="
Push-Location $repo
try {
    & $wails build 2>&1 | Select-String -Pattern 'error|Built' | Select-Object -First 15
    if ($LASTEXITCODE -ne 0) { throw "wails build 失败" }
} finally {
    Pop-Location
}

# 3) 组装运行时文件：exe 同目录必须有 pdf.exe (+ 它的 _internal) / ocr.py / convert_external.py
Write-Output "`n=== [3/3] 组装运行时文件 ==="
$pdDir = Join-Path $repo 'thirdparty\dist\pdf'
$pdExe = Join-Path $pdDir 'pdf.exe'
if (-not (Test-Path $pdExe)) { throw "找不到冻结产物: $pdExe（onedir 模式的产物在 dist\pdf\ 下）" }
Copy-Item $pdExe (Join-Path $binDir 'pdf.exe') -Force

# onedir 的依赖都在 _internal 里，缺了 pdf.exe 起不来。
# 用 robocopy /MIR 做镜像：它只复制变化的部分，比整目录 Copy-Item 快得多。
$internal = Join-Path $pdDir '_internal'
if (Test-Path $internal) {
    $dst = Join-Path $binDir '_internal'
    # robocopy 用 0~7 表示"成功"（1 = 有文件被复制），但 PowerShell 7 在
    # ErrorActionPreference=Stop 下会把任何非零退出码当致命错误——必须临时关掉，
    # 否则第一次复制就会中断构建（第二次没东西可复制、返回 0，反而不报错，很难查）。
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        robocopy $internal $dst /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
        $rc = $LASTEXITCODE
    } finally {
        $PSNativeCommandUseErrorActionPreference = $prevNative
    }
    if ($rc -ge 8) { throw "复制 _internal 失败 (robocopy 退出码 $rc)" }
} else {
    Write-Warning "没有找到 _internal 目录，pdf.exe 可能无法启动"
}

foreach ($f in 'ocr.py', 'convert_external.py') {
    $src = Join-Path $repo "thirdparty\$f"
    if (Test-Path $src) { Copy-Item $src (Join-Path $binDir $f) -Force }
}

Write-Output "`n完成，产物："
Get-ChildItem $binDir |
    Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime |
    Format-Table -AutoSize
