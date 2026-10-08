# Registra una tarea programada de Windows que corre alarma-turso.ps1 todos los dias
# a las 9:00 AM (si la PC estaba apagada a esa hora, corre apenas se prenda). Corre
# solo con tu sesion abierta, para poder mostrarte la notificacion. Se instala una vez:
#
#   powershell -ExecutionPolicy Bypass -File scripts\instalar-tarea-alarma-turso.ps1
#
# Para revisarla despues: Get-ScheduledTask -TaskName "AlarmaCupoTurso"
# Para quitarla: Unregister-ScheduledTask -TaskName "AlarmaCupoTurso"

$scriptPath = Join-Path $PSScriptRoot "alarma-turso.ps1"

$accion = New-ScheduledTaskAction -Execute "powershell.exe" `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`""
$disparador = New-ScheduledTaskTrigger -Daily -At 9:00AM
$config = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd

Register-ScheduledTask -TaskName "AlarmaCupoTurso" `
  -Action $accion -Trigger $disparador -Settings $config `
  -Description "Revisa a diario el cupo de filas leidas de Turso y avisa antes de que se bloquee." `
  -Force

Write-Host "Tarea programada instalada: revisa el cupo de Turso todos los dias a las 9:00 AM."
