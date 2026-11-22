$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$backupDirectory = Join-Path $workspacePath '.backups'
[System.IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$envPath = Join-Path $workspacePath '.env'
$scriptPath = Join-Path $workspacePath 'scripts\db-backup.mjs'

# Keep both the scheduler wrapper and Node hidden, with diagnostics in the
# ignored backup folder. Neither stream includes encryption keys or file names.
$backupExitCode = 1
for ($attempt = 1; $attempt -le 3; $attempt++) {
    $process = Start-Process -FilePath $nodePath -ArgumentList @("--env-file=`"$envPath`"", "`"$scriptPath`"") -WorkingDirectory $workspacePath -WindowStyle Hidden -Wait -PassThru -RedirectStandardOutput (Join-Path $backupDirectory 'task-output.log') -RedirectStandardError (Join-Path $backupDirectory 'task-error.log')
    $backupExitCode = $process.ExitCode
    $process.Dispose()
    if ($backupExitCode -eq 0) { exit 0 }
    # A cold compute or a brief connection outage must not skip the entire interval.
    if ($attempt -lt 3) { Start-Sleep -Seconds (5 * $attempt) }
}
exit $backupExitCode
