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
if (-not $SkipFreeze) {
    Write-Output "`n=== [1/3] 冻结 pdf.exe ==="
    Push-Location (Join-Path $repo 'thirdparty')
    try {
        & $python -m PyInstaller -F -w pdf.py --distpath dist --workpath build --noconfirm 2>&1 |
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

# 3) 组装运行时文件：exe 同目录必须有 pdf.exe / ocr.py / convert_external.py
Write-Output "`n=== [3/3] 组装运行时文件 ==="
Copy-Item (Join-Path $repo 'thirdparty\dist\pdf.exe') (Join-Path $binDir 'pdf.exe') -Force
foreach ($f in 'ocr.py', 'convert_external.py') {
    $src = Join-Path $repo "thirdparty\$f"
    if (Test-Path $src) { Copy-Item $src (Join-Path $binDir $f) -Force }
}

Write-Output "`n完成，产物："
Get-ChildItem $binDir |
    Select-Object Name, @{ n = 'MB'; e = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime |
    Format-Table -AutoSize
