// AnnesChessKit.exe for a source checkout (not the single-file download): a tiny windowless launcher that
// starts the app (.venv\Scripts\pythonw.exe run.py) hidden, so no console window appears. Before the first
// start there is no .venv yet: then it opens AnnesChessKit.bat, which sets Python up in a visible window.
//
// Build (no extra tools – the C# compiler ships with Windows' .NET Framework):
//   scripts\launcher\build.bat
using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Windows.Forms;

static class Launcher
{
    const string Title = "Anne's Chess Kit";

    [STAThread]
    static void Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string pythonw = Path.Combine(root, ".venv", "Scripts", "pythonw.exe");
        if (!File.Exists(pythonw)) pythonw = null;
        string runPy = Path.Combine(root, "run.py");
        try
        {
            if (!File.Exists(runPy))
            {
                MessageBox.Show("run.py is missing next to AnnesChessKit.exe.\n\nAnnesChessKit.exe only starts the app - keep it inside its folder " +
                                "(make a shortcut to it instead of moving it).", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (pythonw == null)
            {
                // First start from source: set up Python (visible, so errors can be seen); it starts the app afterwards.
                Process.Start(new ProcessStartInfo(Path.Combine(root, "AnnesChessKit.bat")) { WorkingDirectory = root, UseShellExecute = true });
                return;
            }
            string extra = string.Join(" ", args.Select(a => "\"" + a.Replace("\"", "\\\"") + "\""));
            Process.Start(new ProcessStartInfo(pythonw, "\"" + runPy + "\" " + extra)
            {
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
        catch (Exception e)
        {
            MessageBox.Show(Title + " could not start:\n\n" + e.Message, Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }
}
