// MIT. Single-instance tray owner. Closing the Quark window leaves this running.
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Security.Principal;
[assembly: AssemblyTitle("伴屿双端工作台")]
[assembly: AssemblyProduct("伴屿")]
[assembly: AssemblyDescription("QQ 与微信统一启动和管理")]
[assembly: AssemblyVersion("2.3.1.0")]
[assembly: AssemblyFileVersion("2.3.1.0")]
internal static class BanyuLauncher
{
    [STAThread]
    private static void Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string id;
        string owner = WindowsIdentity.GetCurrent().User.Value;
#if BANYU_TEST
        string testScope = Environment.GetEnvironmentVariable("BANYU_TEST_INSTANCE");
        if (String.IsNullOrEmpty(testScope)) return;
        owner += "-isolated-test-" + testScope;
#endif
        using (var hash = SHA256.Create()) id = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(owner))).Replace("-", "").Substring(0, 24);
        bool first;
        using (var mutex = new Mutex(true, "Global\\BanyuDeskTray-" + id, out first))
        using (var open = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\BanyuDeskOpen-" + id))
        using (var quit = new EventWaitHandle(false, EventResetMode.AutoReset, "Global\\BanyuDeskExit-" + id))
        {
            bool exit = args.Length == 1 && args[0] == "--exit";
            if (!first) { (exit ? quit : open).Set(); return; }
            if (exit) { mutex.ReleaseMutex(); return; }
            try
            {
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                using (var context = new DeskTray(root, open, quit)) Application.Run(context);
            }
            catch (Exception error) { try { Directory.CreateDirectory(Path.Combine(root, "logs")); File.AppendAllText(Path.Combine(root, "logs", "tray-error.log"), error.GetType().Name + ": " + error.Message + Environment.NewLine + error.StackTrace + Environment.NewLine); } catch { } MessageBox.Show("伴屿未能启动。请完整解压文件夹后，再打开 Banyu.exe。", "伴屿", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            finally { mutex.ReleaseMutex(); }
        }
    }
}
internal sealed class DeskTray : ApplicationContext
{
    private readonly string root;
    private readonly Control dispatch = new Control();
    private readonly NotifyIcon tray;
    private readonly Icon icon;
    private readonly ContextMenuStrip menu;
    private readonly RegisteredWaitHandle openWait, exitWait;
    private bool opening;
    private bool disposed;
    private volatile bool exiting;
    private readonly object helperLock = new object();
    private Process helper;
    public DeskTray(string directory, EventWaitHandle open, EventWaitHandle quit)
    {
        root = directory;
        var handle = dispatch.Handle;
        menu = new ContextMenuStrip();
        menu.Items.Add("打开工作台", null, delegate { Open(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("退出伴屿", null, delegate { Quit(); });
        icon = new Icon(Path.Combine(root, "public", "icon-banyu.ico"));
        tray = new NotifyIcon { Text = "伴屿 · 后台运行", Icon = icon, ContextMenuStrip = menu, Visible = true };
        tray.DoubleClick += delegate { Open(); };
        openWait = ThreadPool.RegisterWaitForSingleObject(open, delegate { Post(Open); }, null, Timeout.Infinite, false);
        exitWait = ThreadPool.RegisterWaitForSingleObject(quit, delegate { Post(Quit); }, null, Timeout.Infinite, false);
        Post(Open);
    }
    private void Post(Action action)
    {
        if (dispatch.IsDisposed) return;
        try { dispatch.BeginInvoke(action); } catch (InvalidOperationException) { }
    }
    private bool Run(string name, int timeout, bool interactive = false)
    {
        string script = Path.Combine(root, name);
        if (!File.Exists(script)) throw new FileNotFoundException();
        var start = new ProcessStartInfo {
            FileName = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell", "v1.0", "powershell.exe"),
            Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle " + (interactive ? "Normal" : "Hidden") + " -File \"" + script + "\"",
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = !interactive
        };
        Process process;
        lock (helperLock) { if (exiting && name != "Stop-Desk.ps1") return false; process = Process.Start(start); helper = process; }
        using (process)
        {
            try { if (!process.WaitForExit(timeout)) { process.Kill(); return false; } return process.ExitCode == 0; }
            finally { lock (helperLock) { if (helper == process) helper = null; } }
        }
    }
    private void Open()
    {
        if (opening || exiting) return;
        opening = true;
        ThreadPool.QueueUserWorkItem(delegate {
            bool ok = false;
            try { ok = File.Exists(Path.Combine(root, "data", "machine-settings.json")) || Run("Setup-Workspace.ps1", Timeout.Infinite, true); if (ok && !exiting) ok = Run("Launch-Desk.ps1", Timeout.Infinite); } catch { }
            Post(delegate {
                opening = false;
                if (!ok && !exiting) { tray.BalloonTipTitle = "伴屿"; tray.BalloonTipText = "工作台暂未能打开，请检查本机设置后重试。"; tray.ShowBalloonTip(4000); }
            });
        });
    }
    private void Quit()
    {
        if (exiting) return;
        exiting = true; menu.Enabled = false; tray.Text = "伴屿 · 正在退出";
        lock (helperLock) { try { if (helper != null && !helper.HasExited) helper.Kill(); } catch (InvalidOperationException) { } }
        ThreadPool.QueueUserWorkItem(delegate {
            bool ok = false;
            try { ok = Run("Stop-Desk.ps1", 35000); } catch { }
            Post(delegate {
                if (ok) { tray.Visible = false; ExitThread(); }
                else { exiting = false; menu.Enabled = true; tray.Text = "伴屿 · 后台运行"; MessageBox.Show("后台尚未完成退出，请稍后重试。未停止其他 QQ 或 DSH 程序。", "伴屿", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            });
        });
    }
    protected override void Dispose(bool disposing)
    {
        if (disposing && !disposed) { disposed = true; if (openWait != null) openWait.Unregister(null); if (exitWait != null) exitWait.Unregister(null); if (tray != null) { tray.Visible = false; tray.Dispose(); } if (icon != null) icon.Dispose(); if (menu != null) menu.Dispose(); dispatch.Dispose(); }
        base.Dispose(disposing);
    }
}
