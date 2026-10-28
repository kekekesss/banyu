# Only focuses a window with the workbench title owned by the configured Quark.
if (-not ('BanyuWindow' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class BanyuWindow {
    private delegate bool EnumProc(IntPtr hwnd, IntPtr state);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr state);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr hwnd, int action);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    public static IntPtr[] Find(string executable, string title) {
        var found = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr state) {
            if (!IsWindowVisible(hwnd)) return true;
            var text = new StringBuilder(1024); GetWindowText(hwnd, text, text.Capacity);
            if (text.ToString() != title && text.ToString() != title + " - 夸克") return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            try { using (var process = Process.GetProcessById((int)pid)) {
                if (String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(executable), StringComparison.OrdinalIgnoreCase)) found.Add(hwnd);
            }} catch { }
            return true;
        }, IntPtr.Zero);
        return found.ToArray();
    }
    public static void Focus(IntPtr hwnd) { ShowWindowAsync(hwnd, 9); SetForegroundWindow(hwnd); }
}
'@
}
function Focus-DeskWindow {
    param([string]$QuarkPath, [string]$Title='伴屿双端工作台')
    $windows = [BanyuWindow]::Find($QuarkPath, $Title)
    if ($windows.Length -eq 0) { return $false }
    [BanyuWindow]::Focus($windows[0])
    return $true
}
