// OS 级窗口/光标操作助手（v1.28.3 贴边隐藏测试与实拍共用）。
// 写成 .ps1 经 powershell -File 调用（-Command 会把参数拼进脚本体导致 $args 失效）；
// 进程置 DPI 感知，内部物理像素，对外全部折算成 Electron DIP（与 main.js bounds 一致）。
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PS1 = path.join(__dirname, '_winops.ps1');
if (!fs.existsSync(PS1)) {
  fs.writeFileSync(PS1, '﻿' + String.raw`
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class WU {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int w, int hh, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, uint data, int extra);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int Left, Top, Right, Bottom; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  public static IntPtr Find(string suffix) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      if (sb.ToString().EndsWith(suffix)) found = h;
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[WU]::SetProcessDPIAware() | Out-Null
$g = [System.Drawing.Graphics]::FromHwnd([IntPtr]::Zero)
$script:scale = $g.DpiX / 96.0
$g.Dispose()
function P2D($v) { return [int][Math]::Round($v / $script:scale) }  # 物理 → DIP
function D2P($v) { return [int][Math]::Round([double]$v * $script:scale) } # DIP → 物理
$hw = [WU]::Find('专注计时器 Mini')
if ($hw -eq [IntPtr]::Zero) { echo 'ERR no mini window'; exit 1 }
$r = New-Object WU+RECT
switch ($args[0]) {
  'rect'   { [WU]::GetWindowRect($hw, [ref]$r) | Out-Null
             echo "$(P2D $r.Left) $(P2D $r.Top) $(P2D ($r.Right-$r.Left)) $(P2D ($r.Bottom-$r.Top))" }
  'move'   { [WU]::GetWindowRect($hw, [ref]$r) | Out-Null
             [WU]::SetWindowPos($hw, [IntPtr]::Zero, (D2P $args[1]), (D2P $args[2]), ($r.Right-$r.Left), ($r.Bottom-$r.Top), 0x0014) | Out-Null; echo 'ok' }
  'cursor' { [WU]::SetCursorPos((D2P $args[1]), (D2P $args[2])) | Out-Null; echo 'ok' }
  'wa'     { $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
             echo "$(P2D $wa.X) $(P2D $wa.Y) $(P2D $wa.Width) $(P2D $wa.Height)" }
  'sweep'  { [WU]::GetWindowRect($hw, [ref]$r) | Out-Null
             $w = $r.Right-$r.Left; $h = $r.Bottom-$r.Top
             [WU]::SetWindowPos($hw, [IntPtr]::Zero, (D2P $args[1]), (D2P $args[2]), $w, $h, 0x0014) | Out-Null
             Start-Sleep -Milliseconds 100
             [WU]::SetWindowPos($hw, [IntPtr]::Zero, (D2P $args[3]), (D2P $args[4]), $w, $h, 0x0014) | Out-Null; echo 'ok' }
  # 真实拖拽：按住左键从 (x1,y1) 拖到 (x2,y2)（DIP），用于验证 app-region 拖拽
  'drag'   { $x1=(D2P $args[1]); $y1=(D2P $args[2]); $x2=(D2P $args[3]); $y2=(D2P $args[4])
             [WU]::SetCursorPos($x1, $y1) | Out-Null
             Start-Sleep -Milliseconds 150
             [WU]::mouse_event(0x02, 0, 0, 0, 0) # LEFTDOWN
             for ($i=1; $i -le 8; $i++) {
               [WU]::SetCursorPos($x1 + ($x2-$x1)*$i/8, $y1 + ($y2-$y1)*$i/8) | Out-Null
               Start-Sleep -Milliseconds 30
             }
             [WU]::mouse_event(0x04, 0, 0, 0, 0) # LEFTUP
             echo 'ok' }
  'shot'   { $x=(D2P $args[1]); $y=(D2P $args[2]); $w=(D2P $args[3]); $h=(D2P $args[4])
             $bmp = New-Object System.Drawing.Bitmap $w, $h
             $gg = [System.Drawing.Graphics]::FromImage($bmp)
             $gg.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
             $bmp.Save($args[5]); $gg.Dispose(); $bmp.Dispose(); echo 'ok' }
}
`, 'utf8');
}

function ps(...args) {
  return execFileSync('powershell', ['-NoProfile', '-File', PS1, ...args.map(String)],
    { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}
const rect = () => ps('rect').split(' ').map(Number); // [x, y, w, h]（DIP）
const wa = () => ps('wa').split(' ').map(Number);     // [x, y, w, h]（DIP）

module.exports = { ps, rect, wa };
