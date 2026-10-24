# Attach the given hwnd under the Windows desktop layer (icon container WorkerW/Progman) so that:
#   1) Show Desktop (Win+D / bottom-right button) does NOT hide it - it is no longer a top-level window, so it is not minimized;
#   2) Normally it is covered by any ordinary window - the desktop layer sits at the bottom of the z-order;
#   3) Mouse can pass through - WS_EX_TRANSPARENT is added, so desktop icon clicks/marquee are unaffected.
# Principle: same as Wallpaper Engine / Rainmeter / electron-as-wallpaper (send 0x052C to Progman to enter split mode, then SetParent).
# Only depends on the system's own user32.dll - no third-party module required.
# NOTE: all comments inside the C# here-string below are ASCII on purpose - non-ASCII chars there break Add-Type compilation.

param([long]$hwnd)

$log = Join-Path $PSScriptRoot "inject-desktop.log"
function Log($m) { try { "[$(Get-Date -Format 'HH:mm:ss')] $m" | Out-File -FilePath $log -Append -Encoding utf8 } catch {} }

Log "=== inject start hwnd=$hwnd ===  LOG_FILE=$log ==="

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class U32 {
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr FindWindowEx(IntPtr hWndParent, IntPtr hWndChildAfter, string lpszClass, string lpszWindow);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetParent(IntPtr hWnd);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetParent(IntPtr hWndChild, IntPtr hWndNewParent);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam, uint fuFlags, uint uTimeout, out IntPtr lpdwResult);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const int WS_POPUP = unchecked((int)0x80000000);
    public const int WS_CHILD = 0x40000000;
    public const int WS_EX_TOPMOST = 0x00000008;
    public const int WS_EX_LAYERED = 0x00080000;
    public const int WS_EX_TRANSPARENT = 0x00000020;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SMTO_NORMAL = 0x0000;
    public const uint WM_SHELL = 0x052C;

    private static IntPtr _container;
    private static bool EnumProc(IntPtr w, IntPtr l) {
        IntPtr def = FindWindowEx(w, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (def != IntPtr.Zero) { _container = w; return false; }
        return true;
    }

    // find the icon container: a top-level window that directly contains SHELLDLL_DefView
    public static IntPtr FindIconContainer() {
        _container = IntPtr.Zero;
        EnumWindows(EnumProc, IntPtr.Zero);
        return _container;
    }

    // enter desktop split mode - call ONCE only when not yet attached, to avoid toggling back
    public static void SendShellMessage(IntPtr progman) {
        if (progman == IntPtr.Zero) return;
        IntPtr r = IntPtr.Zero;
        SendMessageTimeout(progman, WM_SHELL, new IntPtr(0xD), new IntPtr(0x1), SMTO_NORMAL, 1000, out r);
    }

    // attach hwnd under parent and fix styles: drop WS_POPUP add WS_CHILD; drop WS_EX_TOPMOST; add WS_EX_LAYERED + WS_EX_TRANSPARENT
    public static string Attach(IntPtr hwnd, IntPtr parent) {
        StringBuilder sb = new StringBuilder();
        IntPtr sp = SetParent(hwnd, parent);
        sb.Append("SetParent->").Append(parent.ToString()).Append(" ret=").Append(sp.ToString());
        int style = GetWindowLong(hwnd, GWL_STYLE);
        int styleNew = (style & ~WS_POPUP) | WS_CHILD;
        SetWindowLong(hwnd, GWL_STYLE, styleNew);
        int styleAfter = GetWindowLong(hwnd, GWL_STYLE);
        sb.Append(" | style 0x").Append(style.ToString("X8")).Append("->0x").Append(styleAfter.ToString("X8"));
        int ex = GetWindowLong(hwnd, GWL_EXSTYLE);
        int exNew = (ex & ~WS_EX_TOPMOST) | WS_EX_LAYERED | WS_EX_TRANSPARENT;
        SetWindowLong(hwnd, GWL_EXSTYLE, exNew);
        int exAfter = GetWindowLong(hwnd, GWL_EXSTYLE);
        sb.Append(" | exstyle 0x").Append(ex.ToString("X8")).Append("->0x").Append(exAfter.ToString("X8"));
        bool ok1 = SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        bool ok2 = SetWindowPos(hwnd, IntPtr.Zero, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        sb.Append(" | SetWindowPos=").Append(ok1).Append("/").Append(ok2);
        return sb.ToString();
    }
}
'@

try {
    Add-Type -TypeDefinition $src -ErrorAction Stop
} catch {
    Log "Add-Type FAILED: $($_.Exception.Message)"
    exit 9
}

$h = [IntPtr]$hwnd
if ($h -eq [IntPtr]::Zero) { Log "hwnd is zero, abort"; exit 2 }

# 1) locate the icon container
$container = [U32]::FindIconContainer()
if ($container -eq [IntPtr]::Zero) {
    $container = [U32]::FindWindow("Progman", $null)
    Log "SHELLDLL_DefView not found, fallback Progman=$container"
} else {
    Log "icon container=$container"
}

# 2) already attached? (parent is already the target container)
$cur = [U32]::GetParent($h)
Log "current parent=$cur container=$container"

if ($cur -ne $container) {
    # first time or after explorer restart -> send 0x052C once, then re-locate the container
    $progman = [U32]::FindWindow("Progman", $null)
    [U32]::SendShellMessage($progman)
    Log "sent 0x052C to progman"
    $container = [U32]::FindIconContainer()
    if ($container -eq [IntPtr]::Zero) { $container = $progman }
    Log "re-located container=$container"
    $result = [U32]::Attach($h, $container)
    Log "attach: $result"
} else {
    # watchdog re-run: parent is already the desktop container, nothing to do.
    # Calling Attach again forces SetParent + SWP_FRAMECHANGED every 15s, which makes
    # the clock/countdown widgets visibly flicker/repaint on the big screen.
    Log "refresh: parent correct, skip (no repaint)"
    exit 0
}

Log "=== inject done hwnd=$hwnd ==="
exit 0
