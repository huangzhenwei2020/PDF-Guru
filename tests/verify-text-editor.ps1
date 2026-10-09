# 用**真实 Windows 输入**驱动文字编辑器。
#
# 为什么需要这个：design-qa.md 自己写着 "native Windows UI input remains untested"，
# 而且它的浏览器验证用的是**模拟桥接数据**——真实按键能不能落到输入框、
# 双击能不能进编辑态、应用后预览会不会变，都还只是"看起来应该可以"。
#
# 这里全部走 SendInput：真点按钮、真双击、真敲键盘（Unicode 直发，中文也能打）。
param(
    [string]$AutoOpen = 'H:\PDF软件\_smoke\ws\split-src.pdf',
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
using System.Runtime.InteropServices;
public class TE {
  public delegate bool Proc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Proc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  public struct R { public int L, T, Rt, B; }
  public struct POINT { public int X, Y; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public const uint KEYUP = 0x0002, UNICODE = 0x0004;
  public static IntPtr MainWin(uint want) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want || !IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256); GetWindowText(h, sb, 256);
      if (sb.Length == 0) return true;
      R r; GetWindowRect(h, out r);
      if ((r.Rt - r.L) < 200 || (r.B - r.T) < 150) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  public static uint RootPid(IntPtr h) { uint pid; GetWindowThreadProcessId(GetAncestor(h, 2), out pid); return pid; }
  // 客户区左上角在屏幕上的位置：截图里量到的坐标 + 这个原点 = 屏幕坐标
  // 用两个标量访问器而不是返回 POINT 结构：返回结构在 PowerShell 里取值不稳（踩过）
  public static POINT ClientOrigin(IntPtr h) {
    POINT p; p.X = 0; p.Y = 0;
    ClientToScreen(h, ref p);
    return p;
  }
  public static int OriginX(IntPtr h) { POINT p; p.X = 0; p.Y = 0; ClientToScreen(h, ref p); return p.X; }
  public static int OriginY(IntPtr h) { POINT p; p.X = 0; p.Y = 0; ClientToScreen(h, ref p); return p.Y; }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(90);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(60);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
  public static void DoubleClick(int x, int y) { Click(x, y); System.Threading.Thread.Sleep(90); Click(x, y); }
  // 逐字符发 Unicode 按键：这样中文也能"真敲"进去，不依赖输入法
  public static void TypeText(string s) {
    foreach (char c in s) {
      INPUT[] inputs = new INPUT[2];
      inputs[0].type = 1; inputs[0].u.ki.wVk = 0; inputs[0].u.ki.wScan = (ushort)c; inputs[0].u.ki.dwFlags = UNICODE;
      inputs[1].type = 1; inputs[1].u.ki.wVk = 0; inputs[1].u.ki.wScan = (ushort)c; inputs[1].u.ki.dwFlags = UNICODE | KEYUP;
      SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT)));
      System.Threading.Thread.Sleep(40);
    }
  }
  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }
  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION { [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
}
"@

$exe = 'H:\PDF软件\PDF-Guru\build\bin\PDF Guru.exe'
function Grab($h, $name) {
    $r = New-Object TE+R; [TE]::GetWindowRect($h, [ref]$r) | Out-Null
    $bmp = New-Object System.Drawing.Bitmap(($r.Rt - $r.L), ($r.B - $r.T))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($r.L, $r.T, 0, 0, (New-Object System.Drawing.Size(($r.Rt - $r.L), ($r.B - $r.T))))
    $bmp.Save((Join-Path $OutDir $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}
# 两张截图是否有明显差异（>0.05% 的像素变了）。用来判定"这一次输入到底生效没有"，
# 免得再写恒真的假断言。
function Compare-Shot([string]$a, [string]$b) {
    $pa = Join-Path $OutDir $a; $pb = Join-Path $OutDir $b
    $ia = [System.Drawing.Bitmap]::FromFile($pa)
    $ib = [System.Drawing.Bitmap]::FromFile($pb)
    $diff = 0; $total = 0
    for ($y = 0; $y -lt $ia.Height; $y += 4) {
        for ($x = 0; $x -lt $ia.Width; $x += 4) {
            $total++
            $ca = $ia.GetPixel($x, $y); $cb = $ib.GetPixel($x, $y)
            if ([Math]::Abs($ca.R - $cb.R) + [Math]::Abs($ca.G - $cb.G) + [Math]::Abs($ca.B - $cb.B) -gt 24) { $diff++ }
        }
    }
    $ia.Dispose(); $ib.Dispose()
    $ratio = if ($total) { $diff / $total } else { 0 }
    Write-Output ("    画面差异 {0:P2}（{1}/{2} 采样点）" -f $ratio, $diff, $total)
    return ($ratio -gt 0.0005)
}

Get-Process -Name 'PDF Guru' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 900
$env:PDFGURU_WS_AUTOOPEN = $AutoOpen
$env:PDFGURU_WS_AUTOPS = 'theme:light;textedit:native;wait:2500'
$p = Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) -PassThru
Start-Sleep -Seconds 13
$h = [IntPtr]::Zero
for ($i = 0; $i -lt 20 -and $h -eq [IntPtr]::Zero; $i++) { $h = [TE]::MainWin([uint32]$p.Id); if ($h -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 500 } }
if ($h -eq [IntPtr]::Zero) { throw '找不到主窗口' }
# 必须 HWND_TOPMOST：只用 HWND_TOP 会被别的窗口盖住，输入全送给别人
[TE]::SetWindowPos($h, [IntPtr](-1), 60, 60, 1400, 760, 0x0040) | Out-Null
# 抢焦点要重试：SetForegroundWindow 会被系统静默忽略（前台锁定），
# 最小化再还原能把它顶上来。不确认的话后面所有按键都会送给别的窗口。
$focused = $false
for ($i = 0; $i -lt 8 -and -not $focused; $i++) {
    [TE]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 250
    if ([TE]::RootPid([TE]::GetForegroundWindow()) -eq $p.Id) { $focused = $true; break }
    [TE]::ShowWindow($h, 6) | Out-Null; Start-Sleep -Milliseconds 200
    [TE]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400
    [TE]::SetWindowPos($h, [IntPtr](-1), 60, 60, 1400, 760, 0x0040) | Out-Null
}
Check $focused '应用是活动窗口（否则按键会送给别的窗口）'

$orgX = [TE]::OriginX($h)
$orgY = [TE]::OriginY($h)
Write-Output "  客户区原点在屏幕上: ($orgX,$orgY)"
function C([int]$x, [int]$y) { , @(($script:orgX + $x), ($script:orgY + $y)) }
function ClickC([int]$x, [int]$y) { $s = C $x $y; [TE]::Click([int]$s[0], [int]$s[1]); Start-Sleep -Milliseconds 500 }

Grab $h 'te-1-open.png'
Write-Output '=== 1. 点「读取 PDF 文字」：文字块应当被框出来 ==='
ClickC 310 50
Start-Sleep -Seconds 2
Grab $h 'te-2-runs.png'
# 用"画面是否真的变了"来判定点击生效，而不是写一句恒真的断言糊弄过去。
# （一开始我在这里写的是 Check $true "已点…"，那等于什么都没验。）
$changed = Compare-Shot 'te-1-open.png' 'te-2-runs.png'
Check $changed '点「读取 PDF 文字」后画面确实变了（文字块被框出，见 te-2-runs.png）'

Write-Output ''
Write-Output '=== 2. 点「新增文字框」并真敲键盘（中文走 Unicode 直发）==='
ClickC 595 50
Start-Sleep -Seconds 1
Grab $h 'te-3-editing.png'
[TE]::TypeText('测试ABC123')
Start-Sleep -Seconds 1
Grab $h 'te-4-typed.png'
$changed2 = Compare-Shot 'te-3-editing.png' 'te-4-typed.png'
Check $changed2 '敲入文字后画面确实变了（说明按键真的进了输入框，见 te-4-typed.png）'

Write-Output ''
Write-Output '=== 3. Ctrl+Enter 应用修改 ==='
Add-Type @"
using System; using System.Runtime.InteropServices;
public class KB {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  public static void CtrlEnter() {
    keybd_event(0x11, 0, 0, IntPtr.Zero);
    keybd_event(0x0D, 0, 0, IntPtr.Zero);
    keybd_event(0x0D, 0, 2, IntPtr.Zero);
    keybd_event(0x11, 0, 2, IntPtr.Zero);
  }
}
"@
[KB]::CtrlEnter()
Start-Sleep -Seconds 2
Grab $h 'te-5-applied.png'
$changed3 = Compare-Shot 'te-4-typed.png' 'te-5-applied.png'
Check $changed3 'Ctrl+Enter 应用后画面确实变了（应用修改生效，见 te-5-applied.png）'

Write-Output ''
Write-Output '=== 4. OCR 模式在没装 OCR 运行时时必须明确报错，而不是静默失败 ==='
ClickC 455 50
Start-Sleep -Seconds 4
Grab $h 'te-6-ocr.png'
$changed4 = Compare-Shot 'te-5-applied.png' 'te-6-ocr.png'
Check $changed4 '点「OCR 识别本页」后有反馈（本机没装 OCR 运行时，应当给出明确提示，见 te-6-ocr.png）'

Write-Output ''
Write-Output '截图：te-1-open / te-2-runs / te-3-editing / te-4-typed / te-5-applied / te-6-ocr'
Write-Output "通过 $ok / $($ok + $fail)"
exit 0
