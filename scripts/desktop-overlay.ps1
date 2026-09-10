param(
  [Parameter(Mandatory = $true)]
  [string]$StateFile,
  [Parameter(Mandatory = $true)]
  [int]$ParentPid
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not ('LunaEyesOverlayForm' -as [type])) {
Add-Type -ReferencedAssemblies 'System.Windows.Forms','System.Drawing' -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;

public sealed class LunaEyesOverlayForm : Form {
    private string mode = "observe";
    private Point? target = null;
    private Rectangle virtualScreen;

    private const int WS_EX_TRANSPARENT = 0x00000020;
    private const int WS_EX_TOOLWINDOW = 0x00000080;
    private const int WS_EX_NOACTIVATE = 0x08000000;

    public LunaEyesOverlayForm(Rectangle bounds) {
        virtualScreen = bounds;
        Bounds = bounds;
        StartPosition = FormStartPosition.Manual;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        BackColor = Color.Magenta;
        TransparencyKey = Color.Magenta;
        DoubleBuffered = true;
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams {
        get {
            CreateParams cp = base.CreateParams;
            cp.ExStyle |= WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
            return cp;
        }
    }

    public void SetState(string nextMode, int? screenX, int? screenY) {
        mode = String.Equals(nextMode, "control", StringComparison.OrdinalIgnoreCase) ? "control" : "observe";
        target = (screenX.HasValue && screenY.HasValue)
            ? new Point(screenX.Value - virtualScreen.Left, screenY.Value - virtualScreen.Top)
            : (Point?)null;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        bool controlling = String.Equals(mode, "control", StringComparison.OrdinalIgnoreCase);
        Color accent = controlling ? Color.FromArgb(0, 120, 212) : Color.FromArgb(38, 132, 255);
        int border = controlling ? 10 : 6;

        using (Pen pen = new Pen(accent, border)) {
            pen.Alignment = PenAlignment.Inset;
            e.Graphics.DrawRectangle(pen, 0, 0, Math.Max(1, ClientSize.Width - 1), Math.Max(1, ClientSize.Height - 1));
        }

        int bannerWidth = controlling ? 560 : 520;
        int bannerHeight = 58;
        int bannerX = Math.Max(12, (ClientSize.Width - bannerWidth) / 2);
        Rectangle banner = new Rectangle(bannerX, 12, bannerWidth, bannerHeight);
        using (SolidBrush brush = new SolidBrush(accent)) e.Graphics.FillRectangle(brush, banner);

        string title = controlling
            ? "Luna \u6b63\u5728\u63a7\u5236\u7535\u8111"
            : "Luna Eyes \u6b63\u5728\u89c2\u5bdf";
        string subtitle = controlling
            ? "LocateAnything  \u00b7  \u8bf7\u6682\u65f6\u4e0d\u8981\u64cd\u4f5c\u9f20\u6807\u6216\u952e\u76d8"
            : "LocateAnything  \u00b7  \u6b63\u5728\u89c6\u89c9\u5b9a\u4f4d\uff0c\u8bf7\u6682\u65f6\u4e0d\u8981\u6539\u53d8\u753b\u9762";
        using (Font titleFont = new Font("Segoe UI", 12f, FontStyle.Bold, GraphicsUnit.Point))
        using (Font subFont = new Font("Segoe UI", 9f, FontStyle.Regular, GraphicsUnit.Point))
        using (SolidBrush white = new SolidBrush(Color.White)) {
            e.Graphics.DrawString(title, titleFont, white, banner.X + 16, banner.Y + 8);
            e.Graphics.DrawString(subtitle, subFont, white, banner.X + 16, banner.Y + 32);
        }

        if (target.HasValue) {
            Point p = target.Value;
            int radius = 19;
            using (Pen targetPen = new Pen(accent, 4)) {
                e.Graphics.DrawEllipse(targetPen, p.X - radius, p.Y - radius, radius * 2, radius * 2);
                e.Graphics.DrawLine(targetPen, p.X - radius - 8, p.Y, p.X + radius + 8, p.Y);
                e.Graphics.DrawLine(targetPen, p.X, p.Y - radius - 8, p.X, p.Y + radius + 8);
            }
            Rectangle tag = new Rectangle(p.X + 24, p.Y - 14, 58, 28);
            using (SolidBrush brush = new SolidBrush(accent)) e.Graphics.FillRectangle(brush, tag);
            using (Font font = new Font("Segoe UI", 9f, FontStyle.Bold, GraphicsUnit.Point))
            using (SolidBrush white = new SolidBrush(Color.White)) e.Graphics.DrawString("Luna", font, white, tag.X + 10, tag.Y + 6);
        }
    }
}
'@
}

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$form = [LunaEyesOverlayForm]::new($bounds)
$lastState = ''

function Update-OverlayState {
  if (-not (Test-Path -LiteralPath $StateFile)) {
    $form.Close()
    return
  }
  try {
    $raw = [IO.File]::ReadAllText($StateFile)
    if ($raw -eq $script:lastState) { return }
    $script:lastState = $raw
    $state = $raw | ConvertFrom-Json
    if ([string]$state.mode -eq 'hidden') {
      $form.Close()
      return
    }
    $x = $null; $y = $null
    if ($null -ne $state.point) {
      $x = [Nullable[int]]([int]$state.point.x)
      $y = [Nullable[int]]([int]$state.point.y)
    }
    $form.SetState([string]$state.mode, $x, $y)
  } catch {
    # State writes are atomic enough for this tiny file, but ignore a partial read and retry.
  }
}

$timer = [System.Windows.Forms.Timer]::new()
$timer.Interval = 100
$timer.Add_Tick({
  try {
    if ($ParentPid -gt 0 -and $null -eq (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) {
      $form.Close()
      return
    }
    Update-OverlayState
  } catch {}
})

$form.Add_Shown({ Update-OverlayState; $timer.Start() })
$form.Add_FormClosed({ $timer.Stop(); $timer.Dispose() })
[System.Windows.Forms.Application]::Run($form)
