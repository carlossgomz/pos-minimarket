# Alarma diaria del cupo de Turso (cuenta infocarloscode: As de Oro, demo, directorio).
#
# El plan gratis de Turso BLOQUEA las bases cuando se pasa de 500M filas leidas en el
# mes (ya paso una vez, el 23/09/2026). Este script lo revisa una vez al dia y avisa
# con una notificacion de Windows ANTES de que llegue a eso:
#   - si al ritmo actual el mes terminaria por encima del 60% del limite,
#   - si en las ultimas ~24 horas se gasto mas de 15M (un pico como el del 06/10),
#   - si ya se paso del 50% del limite,
#   - o si no pudo revisar (sesion del CLI de Turso vencida, sin internet, etc.) -
#     un fallo silencioso es justo lo que no queremos.
# Ademas guarda cada revision en un historial CSV para comparar antes/despues de
# cada arreglo.
#
# Uso manual:   powershell -ExecutionPolicy Bypass -File scripts\alarma-turso.ps1
# Probar aviso: powershell -ExecutionPolicy Bypass -File scripts\alarma-turso.ps1 -Probar
# Programado:   ver scripts\instalar-tarea-alarma-turso.ps1
#
# OJO: Day Express esta en OTRA cuenta de Turso (carlossgomz) y no se revisa aca.

param([switch]$Probar)

$ErrorActionPreference = "Stop"
$Carpeta = "C:\Users\carlo\OneDrive\Documents\WEB DEVELOPER\SISTEMA\monitoreo-turso"
$Historial = Join-Path $Carpeta "historial.csv"
$UmbralProyeccionPct = 60
$UmbralUsoPct = 50
$UmbralDiaFilas = 15e6

function Avisar([string]$titulo, [string]$texto, [string]$tipo = "Warning") {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $icono = New-Object System.Windows.Forms.NotifyIcon
    $icono.Icon = [System.Drawing.SystemIcons]::$tipo
    $icono.BalloonTipIcon = $tipo
    $icono.BalloonTipTitle = $titulo
    $icono.BalloonTipText = $texto
    $icono.Visible = $true
    $icono.ShowBalloonTip(20000)
    Start-Sleep -Seconds 20
    $icono.Dispose()
}

# "76.8M" -> 76800000 ; "<0.1M" -> 0 ; "1.2B" -> 1200000000 ; "425" -> 425
function A-Numero([string]$t) {
    $t = $t.Trim().TrimStart("<")
    if ($t -notmatch '^([\d.]+)\s*([KMB]?)$') { throw "No entiendo el numero '$t'" }
    $n = [double]::Parse($Matches[1], [Globalization.CultureInfo]::InvariantCulture)
    switch ($Matches[2]) { "K" { $n *= 1e3 } "M" { $n *= 1e6 } "B" { $n *= 1e9 } }
    return [math]::Round($n)
}

function Turso([string]$argumentos) {
    # En PowerShell 5.1, con "Stop", cualquier texto que el CLI escriba en stderr
    # (aunque termine bien) se convierte en error - aca se decide por el codigo de salida.
    $ErrorActionPreference = "Continue"
    $salida = wsl bash -lc "~/.turso/turso $argumentos" 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) { throw "turso $argumentos fallo: $salida" }
    return $salida
}

try {
    $plan = Turso "plan show"
    $filaRows = ($plan -split "`n") | Where-Object { $_ -match '^\s*rows read\s' } | Select-Object -First 1
    if (-not $filaRows) { throw "No encontre la fila 'rows read' en: $plan" }
    $partes = ($filaRows.Trim() -split '\s{2,}')
    $usado = A-Numero $partes[1]
    $limite = A-Numero $partes[2]

    # "Quota will reset on Sat, 31 Oct 2026 17:00:00 PDT"
    if ($plan -notmatch 'reset on \w+, (\d+ \w+ \d{4} [\d:]+) (\w+)') { throw "No encontre la fecha de reinicio en: $plan" }
    $reinicio = [datetime]::ParseExact($Matches[1], "d MMM yyyy HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
    $inicio = $reinicio.AddMonths(-1)
    $ahora = (Get-Date).ToUniversalTime().AddHours(-7)   # mismo huso que la fecha de Turso (PDT)
    $fraccion = [math]::Max(($ahora - $inicio).TotalHours / ($reinicio - $inicio).TotalHours, 0.02)
    $usoPct = 100 * $usado / $limite
    $proyeccionPct = [math]::Min($usoPct / $fraccion, 999)

    # Filas leidas por base, para saber QUE cliente gasta.
    $bases = (Turso "db list") -split "`n" | Select-Object -Skip 1 |
        ForEach-Object { ($_.Trim() -split '\s+')[0] } | Where-Object { $_ }
    $porBase = @{}
    foreach ($b in $bases) {
        $info = Turso "db inspect $b"
        if ($info -match 'rows read:\s*(\d+)') { $porBase[$b] = [int64]$Matches[1] }
    }

    # Consumo de las ultimas horas comparado con la revision anterior, llevado a 24 h.
    New-Item -ItemType Directory -Force -Path $Carpeta | Out-Null
    $consumo24h = $null
    if (Test-Path $Historial) {
        $ultima = Import-Csv $Historial | Select-Object -Last 1
        $horas = ((Get-Date) - [datetime]$ultima.fecha).TotalHours
        if ($horas -ge 1 -and [int64]$ultima.usado -le $usado) {
            $consumo24h = ($usado - [int64]$ultima.usado) * 24 / $horas
        }
    }

    [pscustomobject]@{
        fecha          = (Get-Date).ToString("yyyy-MM-dd HH:mm")
        usado          = $usado
        limite         = $limite
        uso_pct        = [math]::Round($usoPct, 1)
        proyeccion_pct = [math]::Round($proyeccionPct, 1)
        consumo_24h    = if ($null -ne $consumo24h) { [math]::Round($consumo24h) } else { "" }
        por_base       = ($porBase.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join "; "
    } | Export-Csv $Historial -Append -NoTypeInformation -Encoding UTF8

    $resumen = "Usado: {0:N1}M de {1:N0}M ({2:N0}%). Al ritmo actual el mes cerraria en ~{3:N0}%." -f ($usado / 1e6), ($limite / 1e6), $usoPct, $proyeccionPct
    if ($null -ne $consumo24h) { $resumen += " Ultimas 24 h: ~{0:N1}M." -f ($consumo24h / 1e6) }

    $motivos = @()
    if ($proyeccionPct -ge $UmbralProyeccionPct) { $motivos += "el ritmo apunta a pasar del $UmbralProyeccionPct%" }
    if ($usoPct -ge $UmbralUsoPct) { $motivos += "ya se uso mas del $UmbralUsoPct%" }
    if ($null -ne $consumo24h -and $consumo24h -ge $UmbralDiaFilas) { $motivos += "pico de consumo en el dia" }

    if ($motivos.Count -gt 0) {
        $mayor = $porBase.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
        Avisar "Turso: revisar el consumo" "$($motivos -join ', '). $resumen Mayor consumo: $($mayor.Name)."
    } elseif ($Probar) {
        Avisar "Turso: todo bien (prueba)" $resumen "Info"
    }
    Write-Host $resumen
} catch {
    Avisar "Turso: no se pudo revisar el consumo" "Corre ver-uso-turso.bat o avisale a Claude. Detalle: $($_.Exception.Message)" "Error"
    Write-Host "ERROR: $($_.Exception.Message)"
    exit 1
}
