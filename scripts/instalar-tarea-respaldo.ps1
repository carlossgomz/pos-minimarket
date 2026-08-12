# Registra una tarea programada de Windows que corre respaldo-turso.mjs
# todos los días a las 3:00 AM (hora de la PC), aunque el POS no esté
# abierto. Se corre una sola vez para instalarla:
#
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-tarea-respaldo.ps1
#
# Para revisarla despues: Get-ScheduledTask -TaskName "RespaldoTursoPosMinimarket"
# Para quitarla: Unregister-ScheduledTask -TaskName "RespaldoTursoPosMinimarket"

$nodeExe = (Get-Command node).Source
$scriptPath = Join-Path $PSScriptRoot "respaldo-turso.mjs"

$accion = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$scriptPath`""
$disparador = New-ScheduledTaskTrigger -Daily -At 3:00AM
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "RespaldoTursoPosMinimarket" `
  -Action $accion -Trigger $disparador -Settings $config `
  -Description "Respaldo diario independiente de la base de datos del POS (Turso) a una carpeta en OneDrive." `
  -Force

Write-Host "Tarea programada instalada: corre todos los dias a las 3:00 AM."
