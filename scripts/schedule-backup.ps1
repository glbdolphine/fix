# Creates a Windows scheduled task that backs up Pace IT every day, to a folder on ANOTHER drive.
# Run once, in PowerShell, from the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\schedule-backup.ps1 -BackupDir "E:\PaceItBackups"
param(
  [Parameter(Mandatory = $true)][string]$BackupDir,
  [string]$Time = "13:00"
)
$project = (Get-Location).Path
if (-not (Test-Path (Join-Path $project "package.json"))) { throw "Run this from the folder that contains package.json." }
if ((Split-Path $BackupDir -Qualifier) -eq (Split-Path $project -Qualifier)) {
  Write-Warning "The backup folder is on the same drive as the project. A drive failure would lose both. Choose another drive or a network share."
}
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
$cmd = "cd /d `"$project`" && npm run backup -- `"$BackupDir`" >> `"$BackupDir\backup.log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c $cmd"
$trigger = New-ScheduledTaskTrigger -Daily -At $Time
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries
Register-ScheduledTask -TaskName "PaceIT-Backup" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Scheduled: PaceIT-Backup daily at $Time -> $BackupDir (log: $BackupDir\backup.log)"
Write-Host "Test it now with:  Start-ScheduledTask -TaskName PaceIT-Backup"
