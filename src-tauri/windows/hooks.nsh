; Instala el Visual C++ Redistributable si esta PC no lo tiene — sin esto,
; un cliente real recibió "falta api-ms-win-crt-string-l1-1-0.dll" al abrir
; el programa por primera vez (típico en Windows 7/8 sin actualizar del
; todo). Se corre en silencio DESPUÉS de copiar los archivos, solo si no
; está ya instalado, y se borra el instalador temporal al terminar.
!macro NSIS_HOOK_POSTINSTALL
  ReadRegDWord $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
  ${If} $0 == 1
    DetailPrint "Visual C++ Redistributable ya está instalado"
  ${Else}
    DetailPrint "Instalando Visual C++ Redistributable (necesario para que Kaxa abra)..."
    ExecWait '"$INSTDIR\resources\vc_redist.x64.exe" /install /passive /norestart' $0
  ${EndIf}
  Delete "$INSTDIR\resources\vc_redist.x64.exe"
!macroend
