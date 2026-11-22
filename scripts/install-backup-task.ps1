param([string]$At = '03:00', [ValidateRange(1, 24)][int]$EveryHours = 4)

$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$scriptPath = Join-Path $workspacePath 'scripts\run-backup-task.ps1'
$envPath = Join-Path $workspacePath '.env'
if (!(Test-Path -LiteralPath $scriptPath) -or !(Test-Path -LiteralPath $envPath)) {
    throw 'Run this installer from the vault workspace after configuring .env.'
}

# The task runs as the current signed-in user, without storing a password.
# StartWhenAvailable catches up when this computer wakes or the user signs in.
$powershellPath = Join-Path $PSHOME 'powershell.exe'
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`"" -WorkingDirectory $workspacePath
$firstRun = (Get-Date).Date.Add([TimeSpan]::Parse($At))
$trigger = New-ScheduledTaskTrigger -Once -At $firstRun -RepetitionInterval (New-TimeSpan -Hours $EveryHours)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
$task = Register-ScheduledTask -TaskName 'E2E Database Backup' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "Encrypted and verified Neon database snapshots every $EveryHours hours to Backblaze B2 and the local vault workspace." -Force
$info = Get-ScheduledTaskInfo -TaskName $task.TaskName
[pscustomobject]@{ Task = $task.TaskName; State = $task.State; EveryHours = $EveryHours; StartsAt = $At; NextRunTime = $info.NextRunTime; WorkingDirectory = $workspacePath }
