param([ValidateRange(10, 900)][int]$TimeoutSeconds = 180)

$ErrorActionPreference = 'Stop'
$taskName = 'OverDrive Database Backup'
$startedAt = Get-Date
Start-ScheduledTask -TaskName $taskName
$deadline = $startedAt.AddSeconds($TimeoutSeconds)
$completed = $false
do {
    Start-Sleep -Milliseconds 500
    $task = Get-ScheduledTask -TaskName $taskName
    $info = Get-ScheduledTaskInfo -TaskName $taskName
    if ($info.LastRunTime -ge $startedAt.AddSeconds(-2) -and $task.State -ne 'Running') {
        $completed = $true
        break
    }
} while ((Get-Date) -lt $deadline)
if (!$completed) { throw 'The scheduled backup is still running; check Task Scheduler for completion.' }
if ($info.LastTaskResult -ne 0) { throw "The backup task returned $($info.LastTaskResult). Check .backups/task-error.log." }
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$reportPath = Join-Path $workspacePath '.backups\task-output.log'
$report = Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (!$report.verified -or !$report.statusRecorded) { throw 'The task did not produce a verified backup report.' }
[pscustomobject]@{ Task = $task.TaskName; State = $task.State; LastTaskResult = $info.LastTaskResult; LastRunTime = $info.LastRunTime; NextRunTime = $info.NextRunTime; RepetitionInterval = $task.Triggers[0].Repetition.Interval; BackupVerified = $report.verified }
