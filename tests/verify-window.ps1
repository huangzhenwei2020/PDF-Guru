# 用**操作系统的事实**核对工作区的窗口级行为。
#
# 为什么必须这样做：那份 design-qa.md 自己写明了——
#   "OS-level always-on-top ordering, maximized-window behavior and physical
#    middle-button capture still require a native desktop smoke check;
#    browser bridge checks do not establish those OS effects."
# 也就是说置顶到底生效没有、中键拖动到底被系统送达没有，浏览器里的断言证明不了。
# 这里全部从 Win32 侧取证：
#
#   置顶      读 GWL_EXSTYLE 的 WS_EX_TOPMOST 位
#   精简模式  读 GetWindowRect，看窗口尺寸是否真的变了
#   中键平移  真的按下中键拖动，再比对页面在屏幕上的位置有没有跟着移动
#   滚轮缩放  真的滚滚轮，再看缩放值有没有变
#
# 两个踩过的坑，都写在这里免得下次再犯：
#   1) 不能拿 Process.MainWindowHandle 当主窗口——实测它会返回一个 160x28 的
#      辅助窗口，于是后面所有坐标全错、点击全落空。改成枚举该进程的可见顶层窗口。
#   2) PowerShell **无法绑定名为 Wheel 的静态方法**（方法确实存在，
#      但 [T]::Wheel(120) 一律报"不包含名为 Wheel 的方法"，改名 Wheel2 就正常）。
param(
    [string]$AutoOpen = 'H:\PDF软件\_smoke\ws\big60.pdf',
    [string]$OutDir = 'H:\PDF软件\_smoke\ws'
)

$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName System.Drawing
$ok = 0; $fail = 0
function Check($cond, $msg) {
    if ($cond) { Write-Output "  [OK]   $msg"; $script:ok++ }
    else { Write-Output "  [FAIL] $msg"; $script:fail++ }
}

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W32 {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", SetLastError=true)] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  public struct R { public int L, T, Rt, B; }
  public struct POINT { public int X, Y; }
  public const int GWL_EXSTYLE = -20;
  public const int WS_EX_TOPMOST = 0x00000008;
  public const uint MIDDLEDOWN = 0x0020, MIDDLEUP = 0x0040;
  public const uint WHEEL = 0x0800;
  public static bool IsTopmost(IntPtr h) { return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0; }
  public static void SpinWheel(int delta) { mouse_event(WHEEL, 0, 0, (uint)delta, IntPtr.Zero); }
  public static uint PidAt(int x, int y) {
    POINT p; p.X = x; p.Y = y;
    // 必须取**根窗口**：WindowFromPoint 拿到的是 WebView2 的子窗口，
    // 而那个子窗口属于 msedgewebview2.exe，PID 和目标进程对不上（踩过）。
    IntPtr h = GetAncestor(WindowFromPoint(p), 2 /* GA_ROOT */);
    uint pid; GetWindowThreadProcessId(h, out pid);
    return pid;
  }
  // 某个窗口所属的**根窗口**的 PID。前台窗口可能是 WebView 的子窗口，
  // 直接和主窗口句柄比会误报"不是前台"（踩过）。
  public static uint RootPid(IntPtr h) {
    uint pid; GetWindowThreadProcessId(GetAncestor(h, 2), out pid);
    return pid;
  }
  public static string RectOf(IntPtr h) {
    R r; GetWindowRect(h, out r);
    return string.Format("{0}x{1} at ({2},{3})", r.Rt - r.L, r.B - r.T, r.L, r.T);
  }
  // 主窗口 = 该进程里**可见且带标题**的顶层窗口。
  // 不要用 Process.MainWindowHandle：它在这里会给出错误的小窗口。
  public static IntPtr MainWin(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;
      R r; GetWindowRect(h, out r);
      // 放宽一点：切换模式的那一瞬间窗口可能正在被改尺寸，
      // 阈值卡太高会在那一刻"找不到主窗口"（这个坑踩过）。
      if ((r.Rt - r.L) < 200 || (r.B - r.T) < 150) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
"@

$exe = 'H:\PDF软件\PDF-Guru\build\bin\PDF Guru.exe'
$WIN_W = 1400; $WIN_H = 760; $WIN_X = 60; $WIN_Y = 60

function Launch([string]$ops, [switch]$Arrange) {
    Get-Process -Name 'PDF Guru' -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Milliseconds 900
    $env:PDFGURU_WS_AUTOOPEN = $AutoOpen
    if ($ops) { $env:PDFGURU_WS_AUTOPS = $ops } else { Remove-Item Env:\PDFGURU_WS_AUTOPS -ErrorAction SilentlyContinue }
    $p = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
    Start-Sleep -Seconds 13
    if ($p.HasExited) { throw '程序提前退出' }
    # 重试查找：正好撞上"切换模式改窗口尺寸"的那一瞬间会暂时找不到（踩过）
    $h = [IntPtr]::Zero
    for ($i = 0; $i -lt 20 -and $h -eq [IntPtr]::Zero; $i++) {
        $h = [W32]::MainWin([uint32]$p.Id)
        if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 }
    }
    if ($h -eq [IntPtr]::Zero) { throw '找不到主窗口' }
    if ($Arrange) {
        # 必须用 **HWND_TOPMOST**，不能只用 HWND_TOP：
        # 否则窗口可能被别的窗口盖住，SendInput 的滚轮和中键就送给了那个窗口，
        # 表现为"模拟输入完全无效"。实测：HWND_TOP 时滚轮毫无反应，
        # 改成 TOPMOST 后 zoom 立刻从 0.6 变 1.335。这个坑排查了很久。
        [W32]::SetWindowPos($h, [IntPtr](-1), $WIN_X, $WIN_Y, $WIN_W, $WIN_H, 0x0040) | Out-Null
        [W32]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 1000
    }
    return @{ proc = $p; hwnd = $h }
}
function Rect($h) { $r = New-Object W32+R; [W32]::GetWindowRect($h, [ref]$r) | Out-Null; return $r }
function Size($h) { $r = Rect $h; return @{ w = $r.Rt - $r.L; h = $r.B - $r.T } }
function ImgRect($dump) {
    $m = [regex]::Matches($dump, 'img=(\d+)x(\d+)@(\d+),(\d+)')
    if ($m.Count -eq 0) { return $null }
    $g = $m[$m.Count - 1].Groups
    return @{ w = [int]$g[1].Value; h = [int]$g[2].Value; x = [int]$g[3].Value; y = [int]$g[4].Value }
}
# 等 sizes 写出**新的**快照。
# 不能只按固定秒数睡：sizes 是 ops 里 wait 之后的一步，如果 wait 比"我发输入的时刻"短，
# 读到的就是输入之前那份旧快照，看起来像"输入完全没生效"（踩过，白查半天）。
function WaitDump([string]$old, [int]$timeoutSec = 25) {
    $deadline = (Get-Date).AddSeconds($timeoutSec)
    while ((Get-Date) -lt $deadline) {
        $v = (Get-Clipboard) -join "`n"
        if ($v -and $v.Length -gt 50 -and $v -ne 'EMPTY' -and $v -ne $old) { return $v }
        Start-Sleep -Milliseconds 400
    }
    return ((Get-Clipboard) -join "`n")
}
function Grab($h, $name) {
    $r = Rect $h
    $bmp = New-Object System.Drawing.Bitmap(($r.Rt - $r.L), ($r.B - $r.T))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size(($r.Rt - $r.L), ($r.B - $r.T))))
    $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

# 让应用真正成为**活动窗口**，并确认。
#
# 为什么必须确认：滚轮这类输入需要窗口是活动的。SetForegroundWindow 有时会被
# 系统静默忽略（前台锁定），于是"窗口在光标下、PID 也对，但滚轮毫无反应"，
# 看起来像程序没实现——其实是输入根本没送到。最小化再还原能把它顶上来。
function FocusApp($h, $pid_) {
    for ($i = 0; $i -lt 8; $i++) {
        [W32]::SetForegroundWindow($h) | Out-Null
        Start-Sleep -Milliseconds 250
        if ([W32]::RootPid([W32]::GetForegroundWindow()) -eq $pid_) { return $true }
        [W32]::ShowWindow($h, 6) | Out-Null   # SW_MINIMIZE
        Start-Sleep -Milliseconds 200
        [W32]::ShowWindow($h, 9) | Out-Null   # SW_RESTORE
        Start-Sleep -Milliseconds 400
        [W32]::SetWindowPos($h, [IntPtr](-1), $WIN_X, $WIN_Y, $WIN_W, $WIN_H, 0x0040) | Out-Null
    }
    return ([W32]::RootPid([W32]::GetForegroundWindow()) -eq $pid_)
}

# ---------------------------------------------------------------- 1. 置顶
Write-Output '=== 1. 置顶：必须体现在操作系统的 WS_EX_TOPMOST 位上 ==='
$app = Launch 'theme:light;wait:600'
Check (-not [W32]::IsTopmost($app.hwnd)) '启动时未置顶（WS_EX_TOPMOST=0）'
$app.proc | Stop-Process -Force

$app = Launch 'theme:light;pin;wait:900'
Check ([W32]::IsTopmost($app.hwnd)) '点置顶后 WS_EX_TOPMOST=1 —— 由操作系统确认，不是界面自己声称的'
$app.proc | Stop-Process -Force

$app = Launch 'theme:light;wait:600'
Check (-not [W32]::IsTopmost($app.hwnd)) '重新启动后默认不置顶（排除"启动就置顶"的假象）'
$app.proc | Stop-Process -Force

# ------------------------------------------------------- 2. 精简模式窗口尺寸
Write-Output ''
Write-Output '=== 2. 精简模式：窗口尺寸必须真的变化 ==='
# 切换放在长 wait 之后，这样"切换前"的尺寸是我摆好的那个（第一次写反了顺序，
# 自己把精简后的尺寸又改回 1400x760，白白测出一个假失败）
$app = Launch 'theme:light;wait:16000;compact;wait:4000' -Arrange
$h = $app.hwnd
$s1 = Size $h
Write-Output ("  精简模式前: {0}x{1}" -f $s1.w, $s1.h)
Check (($s1.w -eq $WIN_W) -and ($s1.h -eq $WIN_H)) '切换前窗口尺寸是我设定的值（说明窗口定位确实生效了）'
Start-Sleep -Seconds 8
$s2 = Size $app.hwnd
Write-Output ("  精简模式后: {0}x{1}" -f $s2.w, $s2.h)
Check (($s2.w -ne $s1.w) -or ($s2.h -ne $s1.h)) '切换精简模式后窗口尺寸确实变了（OS 读数，不是 DOM 自称）'
Check ($s2.w -le $s1.w -and $s2.h -le $s1.h) '精简模式不比完整模式更大'
Grab $app.hwnd 'verify-window-compact.png'
$app.proc | Stop-Process -Force

# ---------------------------------------------------------------- 3. 中键平移
Write-Output ''
Write-Output '=== 3. 中键拖动平移：系统级中键必须被送达并生效 ==='
# 放大到 1.6 倍，保证画布两个方向都能滚——否则"没动"可能只是无处可滚
$app = Launch 'theme:light;viewmode:single;zoom:1.6;wait:800'
$app.proc | Stop-Process -Force
Set-Clipboard -Value 'EMPTY'
$app = Launch 'theme:light;viewmode:single;zoom:1.6;wait:600;sizes'
Start-Sleep -Seconds 1
$before = ImgRect ((Get-Clipboard) -join "`n")
$beforeDump = Get-Clipboard -Raw
Check ($null -ne $before) '取到了平移前的页面位置'
$app.proc | Stop-Process -Force

$app = Launch 'theme:light;viewmode:single;zoom:1.6;wait:26000;sizes' -Arrange
$h = $app.hwnd
$r = Rect $h
$cx = $r.L + 700; $cy = $r.T + 400
[W32]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 600
Check ([W32]::PidAt($cx, $cy) -eq $app.proc.Id) '中键落点确实在应用窗口上（按 PID 判定，WebView 子窗口也算）'
Check (FocusApp $h $app.proc.Id) '应用是活动窗口（滚轮/中键需要，注意 SetForegroundWindow 会被系统静默忽略）'
[W32]::mouse_event([W32]::MIDDLEDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le 10; $i++) {
    [W32]::SetCursorPos(($cx - $i * 22), ($cy - $i * 10)) | Out-Null
    Start-Sleep -Milliseconds 35
}
[W32]::mouse_event([W32]::MIDDLEUP, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 800
Grab $h 'verify-window-pan.png'
$after = ImgRect (WaitDump $beforeDump)
Check ($null -ne $after) '取到了平移后的页面位置'
if ($before -and $after) {
    $dx = $after.x - $before.x; $dy = $after.y - $before.y
    Write-Output "  页面位置变化: dx=$dx dy=$dy"
    Check ((($dx * $dx + $dy * $dy) -gt 400)) '中键拖动使视图发生了明显平移（位移 > 20px）'
}
$app.proc | Stop-Process -Force

# ------------------------------------------------------- 4. 滚轮缩放
Write-Output ''
Write-Output '=== 4. 滚轮缩放：物理滚轮必须被 WebView 收到并改变缩放 ==='
$app = Launch 'theme:light;viewmode:single;zoom:0.6;wait:26000;sizes' -Arrange
$h = $app.hwnd
$r = Rect $h
$cx = $r.L + 700; $cy = $r.T + 400
$beforeDump2 = Get-Clipboard -Raw
[W32]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 600
Check ([W32]::PidAt($cx, $cy) -eq $app.proc.Id) '滚轮落点在应用窗口上'
Check (FocusApp $h $app.proc.Id) '应用是活动窗口（滚轮需要）'
[W32]::SetCursorPos($cx, $cy) | Out-Null
Start-Sleep -Milliseconds 400
for ($i = 0; $i -lt 5; $i++) { [W32]::SpinWheel(120); Start-Sleep -Milliseconds 150 }
Start-Sleep -Milliseconds 900
Grab $h 'verify-window-zoom.png'
$z1 = [regex]::Match((WaitDump $beforeDump2), 'zoom=([\d.]+)').Groups[1].Value
Write-Output "  滚轮后的缩放: $z1（起始 0.6）"
Check (([double]$z1) -gt 0.6) '物理滚轮确实改变了缩放（SendInput 送达并被处理）'
$app.proc | Stop-Process -Force

Write-Output ''
Write-Output "通过 $ok / $($ok + $fail)"
if ($fail -gt 0) { exit 1 }
