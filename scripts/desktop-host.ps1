param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadBase64
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

Add-Type -AssemblyName System.Drawing

if (-not ('LunaDesktopNative' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class LunaDesktopNative {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
    [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }
    [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {
        public int dx, dy; public uint mouseData, dwFlags, time; public UIntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {
        public ushort wVk, wScan; public uint dwFlags, time; public UIntPtr dwExtraInfo;
    }

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

    const uint INPUT_KEYBOARD = 1;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    public static object[] ListWindows() {
        var items = new List<object>();
        var foreground = GetForegroundWindow();
        EnumWindows((hWnd, lParam) => {
            if (!IsWindowVisible(hWnd)) return true;
            int length = GetWindowTextLength(hWnd);
            if (length <= 0) return true;
            var title = new StringBuilder(length + 1);
            GetWindowText(hWnd, title, title.Capacity);
            if (String.IsNullOrWhiteSpace(title.ToString())) return true;
            var className = new StringBuilder(256);
            GetClassName(hWnd, className, className.Capacity);
            RECT rect;
            if (!GetWindowRect(hWnd, out rect)) return true;
            uint pid;
            GetWindowThreadProcessId(hWnd, out pid);
            string processName = "";
            try { processName = Process.GetProcessById((int)pid).ProcessName; } catch { }
            items.Add(new {
                hwnd = hWnd.ToInt64().ToString(),
                title = title.ToString(),
                class_name = className.ToString(),
                process_id = pid,
                process_name = processName,
                foreground = hWnd == foreground,
                minimized = IsIconic(hWnd),
                x = rect.Left,
                y = rect.Top,
                width = Math.Max(0, rect.Right - rect.Left),
                height = Math.Max(0, rect.Bottom - rect.Top)
            });
            return true;
        }, IntPtr.Zero);
        return items.ToArray();
    }

    public static RECT WindowRect(long hwnd) {
        RECT rect;
        if (!GetWindowRect(new IntPtr(hwnd), out rect)) throw new InvalidOperationException("Window rectangle is unavailable.");
        return rect;
    }

    public static bool Focus(long hwnd) {
        var handle = new IntPtr(hwnd);
        if (IsIconic(handle)) ShowWindow(handle, 9);
        BringWindowToTop(handle);
        return SetForegroundWindow(handle);
    }

    public static void TypeUnicode(string text) {
        foreach (char ch in text) {
            if (ch == '\r') continue;
            if (ch == '\n') { PressVirtualKey(0x0D); continue; }
            if (ch == '\t') { PressVirtualKey(0x09); continue; }
            var down = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE } } };
            var up = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = ch, dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP } } };
            SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(INPUT)));
        }
    }

    public static void PressVirtualKey(ushort vk) {
        var down = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = 0 } } };
        var up = new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = KEYEVENTF_KEYUP } } };
        SendInput(2, new [] { down, up }, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseWheel(int delta) {
        mouse_event(0x0800, 0, 0, unchecked((uint)delta), UIntPtr.Zero);
    }

    public static void KeyChord(ushort[] keys) {
        var inputs = new List<INPUT>();
        foreach (var vk in keys) inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = vk } } });
        for (int i = keys.Length - 1; i >= 0; i--) inputs.Add(new INPUT { type = INPUT_KEYBOARD, U = new InputUnion { ki = new KEYBDINPUT { wVk = keys[i], dwFlags = KEYEVENTF_KEYUP } } });
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT)));
    }
}
'@
}

function Decode-Payload {
  $bytes = [Convert]::FromBase64String($PayloadBase64)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  return $json | ConvertFrom-Json
}

function Resolve-VirtualKey([string]$Name) {
  $n = $Name.Trim().ToUpperInvariant()
  if ($n.Length -eq 1) {
    $c = [int][char]$n
    if (($c -ge 48 -and $c -le 57) -or ($c -ge 65 -and $c -le 90)) { return [uint16]$c }
  }
  if ($n -match '^F([1-9]|1[0-2])$') { return [uint16](0x70 + [int]$Matches[1] - 1) }
  $map = @{
    'CTRL'=0x11; 'CONTROL'=0x11; 'SHIFT'=0x10; 'ALT'=0x12; 'WIN'=0x5B; 'WINDOWS'=0x5B;
    'ENTER'=0x0D; 'RETURN'=0x0D; 'ESC'=0x1B; 'ESCAPE'=0x1B; 'TAB'=0x09; 'SPACE'=0x20;
    'BACKSPACE'=0x08; 'DELETE'=0x2E; 'INSERT'=0x2D; 'HOME'=0x24; 'END'=0x23;
    'PAGEUP'=0x21; 'PAGEDOWN'=0x22; 'LEFT'=0x25; 'UP'=0x26; 'RIGHT'=0x27; 'DOWN'=0x28
  }
  if (-not $map.ContainsKey($n)) { throw "Unsupported key: $Name" }
  return [uint16]$map[$n]
}

function Mouse-Flags([string]$Button, [bool]$Down) {
  switch ($Button) {
    'left' { if ($Down) { return [uint32]0x0002 } else { return [uint32]0x0004 } }
    'right' { if ($Down) { return [uint32]0x0008 } else { return [uint32]0x0010 } }
    'middle' { if ($Down) { return [uint32]0x0020 } else { return [uint32]0x0040 } }
    default { throw "Unsupported mouse button: $Button" }
  }
}

function Send-Click([int]$X, [int]$Y, [string]$Button, [int]$Count = 1) {
  [LunaDesktopNative]::SetCursorPos($X, $Y) | Out-Null
  for ($i = 0; $i -lt $Count; $i++) {
    [LunaDesktopNative]::mouse_event((Mouse-Flags $Button $true), 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 35
    [LunaDesktopNative]::mouse_event((Mouse-Flags $Button $false), 0, 0, 0, [UIntPtr]::Zero)
    if ($i + 1 -lt $Count) { Start-Sleep -Milliseconds 90 }
  }
}

function Capture-Screenshot($Payload) {
  $left = [LunaDesktopNative]::GetSystemMetrics(76)
  $top = [LunaDesktopNative]::GetSystemMetrics(77)
  $width = [LunaDesktopNative]::GetSystemMetrics(78)
  $height = [LunaDesktopNative]::GetSystemMetrics(79)
  if ($Payload.hwnd) {
    $rect = [LunaDesktopNative]::WindowRect([long]$Payload.hwnd)
    $left = $rect.Left; $top = $rect.Top
    $width = [Math]::Max(1, $rect.Right - $rect.Left)
    $height = [Math]::Max(1, $rect.Bottom - $rect.Top)
  }
  $bitmap = [Drawing.Bitmap]::new($width, $height)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($left, $top, 0, 0, [Drawing.Size]::new($width, $height)) }
  finally { $graphics.Dispose() }

  $output = $bitmap
  if ($width -gt [int]$Payload.max_width) {
    $scaledWidth = [int]$Payload.max_width
    $scaledHeight = [Math]::Max(1, [int][Math]::Round($height * ($scaledWidth / [double]$width)))
    $scaled = [Drawing.Bitmap]::new($scaledWidth, $scaledHeight)
    $g2 = [Drawing.Graphics]::FromImage($scaled)
    try {
      $g2.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g2.DrawImage($bitmap, 0, 0, $scaledWidth, $scaledHeight)
    } finally { $g2.Dispose() }
    $bitmap.Dispose()
    $output = $scaled
    $width = $scaledWidth; $height = $scaledHeight
  }

  $stream = [IO.MemoryStream]::new()
  try {
    $codec = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
    $encParams = [Drawing.Imaging.EncoderParameters]::new(1)
    $encParams.Param[0] = [Drawing.Imaging.EncoderParameter]::new([Drawing.Imaging.Encoder]::Quality, [long]$Payload.quality)
    $output.Save($stream, $codec, $encParams)
    $bytes = $stream.ToArray()
    return [ordered]@{
      ok = $true
      operation = 'screenshot'
      mime_type = 'image/jpeg'
      width = $width
      height = $height
      source_x = $left
      source_y = $top
      bytes = $bytes.Length
      data_url = 'data:image/jpeg;base64,' + [Convert]::ToBase64String($bytes)
    }
  } finally {
    $stream.Dispose(); $output.Dispose()
  }
}

try {
  $p = Decode-Payload
  switch ([string]$p.operation) {
    'windows' {
      $result = [ordered]@{ ok=$true; operation='windows'; windows=[LunaDesktopNative]::ListWindows() }
    }
    'screenshot' { $result = Capture-Screenshot $p }
    'focus' {
      $focused = [LunaDesktopNative]::Focus([long]$p.hwnd)
      Start-Sleep -Milliseconds 120
      $result = [ordered]@{ ok=$true; operation='focus'; hwnd=[string]$p.hwnd; focused=$focused }
    }
    'move' {
      [LunaDesktopNative]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null
      $result = [ordered]@{ ok=$true; operation='move'; x=[int]$p.x; y=[int]$p.y }
    }
    'click' {
      Send-Click ([int]$p.x) ([int]$p.y) ([string]$p.button) 1
      $result = [ordered]@{ ok=$true; operation='click'; x=[int]$p.x; y=[int]$p.y; button=[string]$p.button }
    }
    'double_click' {
      Send-Click ([int]$p.x) ([int]$p.y) ([string]$p.button) 2
      $result = [ordered]@{ ok=$true; operation='double_click'; x=[int]$p.x; y=[int]$p.y; button=[string]$p.button }
    }
    'drag' {
      $fx=[int]$p.from_x; $fy=[int]$p.from_y; $tx=[int]$p.to_x; $ty=[int]$p.to_y
      [LunaDesktopNative]::SetCursorPos($fx, $fy) | Out-Null
      [LunaDesktopNative]::mouse_event((Mouse-Flags ([string]$p.button) $true), 0, 0, 0, [UIntPtr]::Zero)
      $steps = [Math]::Max(2, [Math]::Min(60, [int]([int]$p.duration_ms / 16)))
      for ($i=1; $i -le $steps; $i++) {
        $ratio = $i / [double]$steps
        [LunaDesktopNative]::SetCursorPos([int][Math]::Round($fx + (($tx-$fx)*$ratio)), [int][Math]::Round($fy + (($ty-$fy)*$ratio))) | Out-Null
        Start-Sleep -Milliseconds ([Math]::Max(1, [int]([int]$p.duration_ms / $steps)))
      }
      [LunaDesktopNative]::mouse_event((Mouse-Flags ([string]$p.button) $false), 0, 0, 0, [UIntPtr]::Zero)
      $result = [ordered]@{ ok=$true; operation='drag'; from_x=$fx; from_y=$fy; to_x=$tx; to_y=$ty; button=[string]$p.button }
    }
    'scroll' {
      if ($null -ne $p.x -and $null -ne $p.y) { [LunaDesktopNative]::SetCursorPos([int]$p.x, [int]$p.y) | Out-Null }
      [LunaDesktopNative]::MouseWheel([int]$p.delta)
      $result = [ordered]@{ ok=$true; operation='scroll'; delta=[int]$p.delta }
    }
    'type' {
      [LunaDesktopNative]::TypeUnicode([string]$p.text)
      $result = [ordered]@{ ok=$true; operation='type'; length=([string]$p.text).Length }
    }
    'key' {
      $tokens = ([string]$p.key).Split('+') | Where-Object { $_ }
      $keys = [System.Collections.Generic.List[uint16]]::new()
      foreach ($token in $tokens) { $keys.Add((Resolve-VirtualKey $token)) }
      [LunaDesktopNative]::KeyChord($keys.ToArray())
      $result = [ordered]@{ ok=$true; operation='key'; key=[string]$p.key }
    }
    default { throw "Unsupported desktop operation: $($p.operation)" }
  }
  $result | ConvertTo-Json -Depth 8 -Compress
} catch {
  [ordered]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Compress
  exit 1
}
