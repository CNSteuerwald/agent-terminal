'use strict';
// A small "Updating Agent Terminal" window shown while the installer runs (it installs silently, so
// otherwise nothing is on screen between "Restart now" and the new version opening). It runs in its own
// PowerShell (WPF) process because the app has to quit before it can be replaced. It closes when the
// updated app shows a window, or after 3 minutes if the update never comes up.
const path = require('path');
const { spawn } = require('child_process');

const psString = s => `'${String(s).replace(/'/g, "''")}'`;

function splashScript({ version, exe, pid }) {
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName PresentationFramework, System.Drawing
$exe = ${psString(exe)}
$name = [IO.Path]::GetFileNameWithoutExtension($exe)
[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation" Title="Updating Agent Terminal"
  Width="340" SizeToContent="Height" WindowStyle="None" ResizeMode="NoResize" WindowStartupLocation="CenterScreen"
  Topmost="True" Background="#202020" BorderBrush="#3a3a3a" BorderThickness="1">
  <StackPanel Margin="20">
    <Grid>
      <Grid.ColumnDefinitions><ColumnDefinition Width="Auto"/><ColumnDefinition Width="*"/></Grid.ColumnDefinitions>
      <Image Name="AppIcon" Width="32" Height="32" Margin="0,0,12,0" VerticalAlignment="Center"/>
      <StackPanel Grid.Column="1" VerticalAlignment="Center">
        <TextBlock Text="Updating Agent Terminal" Foreground="#e6e6e6" FontSize="14" FontWeight="SemiBold"/>
        <TextBlock Name="Detail" Foreground="#9d9d9d" FontSize="12" Margin="0,2,0,0" TextWrapping="Wrap"/>
      </StackPanel>
    </Grid>
    <ProgressBar IsIndeterminate="True" Height="4" Margin="0,16,0,0" Foreground="#4cc2ff" Background="#3a3a3a" BorderThickness="0"/>
  </StackPanel>
</Window>
'@
$w = [Windows.Markup.XamlReader]::Load((New-Object Xml.XmlNodeReader $xaml))
$w.FindName('Detail').Text = ${psString(`Installing version ${version}. Your tabs come back when it reopens.`)}
$icon = [Drawing.Icon]::ExtractAssociatedIcon($exe)
if ($icon) {
  $w.FindName('AppIcon').Source = [Windows.Interop.Imaging]::CreateBitmapSourceFromHIcon($icon.Handle, [Windows.Int32Rect]::Empty, [Windows.Media.Imaging.BitmapSizeOptions]::FromEmptyOptions())
}
$deadline = (Get-Date).AddMinutes(3)
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$timer.Add_Tick({
  if ((Get-Date) -gt $deadline) { $w.Close(); return }
  if (Get-Process -Id ${Number(pid)}) { return } # the old version is still quitting
  if (Get-Process -Name $name | Where-Object { $_.MainWindowHandle -ne 0 }) { $w.Close() }
})
$timer.Start()
[void]$w.ShowDialog()
`;
}

function showUpdateSplash({ version, exe = process.execPath, pid = process.pid }) {
  if (process.platform !== 'win32') return;
  const script = splashScript({ version, exe: path.resolve(exe), pid });
  try {
    spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } catch { /* no splash; the update still installs */ }
}

module.exports = { showUpdateSplash, splashScript };
