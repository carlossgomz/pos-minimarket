; Instala el Visual C++ Redistributable si esta PC no lo tiene — sin esto,
; un cliente real recibió "falta api-ms-win-crt-string-l1-1-0.dll" al abrir
; el programa por primera vez (típico en Windows 7/8 sin actualizar del
; todo). Se corre en silencio DESPUÉS de copiar los archivos, solo si no
; está ya instalado, y se borra el instalador temporal al terminar.
;
; También instala las dos credenciales de Amazon que firman el certificado
; de Turso (la base de datos) — en una PC vieja/sin actualizar, a Windows
; le puede faltar esta credencial en su lista de confianza local, y Kaxa
; (a diferencia de Chrome/Edge, que traen su propia lista aparte) SÍ
; depende de la lista de Windows para conectar. Sin esto, un cliente real
; recibió "UnknownIssuer" al conectar por primera vez y hubo que
; instalarlas a mano en su PC — con esto ya viene resuelto de fábrica.
; certutil ya viene incluido en Windows, no hace falta instalar nada
; aparte para correr esto. "-f" no falla si la credencial ya estaba.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    DetailPrint "Visual C++ Redistributable ya está instalado"
  ${Else}
    DetailPrint "Instalando Visual C++ Redistributable (necesario para que Kaxa abra)..."
    ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /passive /norestart' $0
  ${EndIf}
  Delete "$INSTDIR\resources\vc_redist.x64.exe"

  DetailPrint "Instalando credenciales de seguridad para conectar con la base de datos..."
  ExecWait 'certutil -addstore -f root "$INSTDIR\resources\AmazonRootCA1.cer"' $0
  ExecWait 'certutil -addstore -f CA "$INSTDIR\resources\AmazonRSA2048M01.cer"' $0
  Delete "$INSTDIR\resources\AmazonRootCA1.cer"
  Delete "$INSTDIR\resources\AmazonRSA2048M01.cer"
!macroend
