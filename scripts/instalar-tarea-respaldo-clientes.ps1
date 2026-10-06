# Registra una tarea programada de Windows que corre respaldo-clientes.mjs
# todos los días a las 3:15 AM (15 minutos después del respaldo de Day
# Express, para no correr los dos a la vez). Se corre una sola vez:
#
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-tarea-respaldo-clientes.ps1
#
# Para revisarla despues: Get-ScheduledTask -TaskName "RespaldoTursoClientesKaxa"
# Para quitarla: Unregister-ScheduledTask -TaskName "RespaldoTursoClientesKaxa"

$nodeExe = (Get-Command node).Source
$scriptPath = Join-Path $PSScriptRoot "respaldo-clientes.mjs"

$accion = New-ScheduledTaskAction -Execute $nodeExe -Argument "`"$scriptPath`"" -WorkingDirectory (Split-Path $PSScriptRoot)
$disparador = New-ScheduledTaskTrigger -Daily -At 3:15AM
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "RespaldoTursoClientesKaxa" `
  -Action $accion -Trigger $disparador -Settings $config `
  -Description "Respaldo diario independiente de las bases Turso de los clientes de Kaxa a una carpeta en OneDrive." `
  -Force

Write-Host "Tarea programada instalada: corre todos los dias a las 3:15 AM."
