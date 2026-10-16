; NSIS customization for the Your Player installer/uninstaller.
;
; INSTALL: never checks for running instances, never closes anything, never
; removes files — it only installs. This replaces electron-builder's default
; app-running check (the "cannot be closed / Retry" dialog) with nothing.
!macro customCheckAppRunning
!macroend

; INSTALL: refresh yt-dlp. YouTube changes often, so the yt-dlp.exe baked into
; the installer may be old by the time the user runs setup. Download the
; current release with curl (ships with Windows 10+; PowerShell fallback),
; validate the size, then put it in place. Failure is non-fatal — the bundled
; fallback stays in place and still works.
!macro customInstall
  CreateDirectory "$INSTDIR\resources\vendor"
  DetailPrint "Fetching the latest yt-dlp for YouTube downloads…"
  Delete "$INSTDIR\resources\vendor\yt-dlp.fresh"
  nsExec::ExecToStack '"$SYSDIR\curl.exe" -L --retry 2 --fail -s -o "$INSTDIR\resources\vendor\yt-dlp.fresh" "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"'
  Pop $R0
  ${If} $R0 != 0
    nsExec::ExecToStack 'powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri \"https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe\" -OutFile \"$INSTDIR\resources\vendor\yt-dlp.fresh\" -UseBasicParsing"'
    Pop $R0
  ${EndIf}
  StrCpy $R1 0
  ${If} ${FileExists} "$INSTDIR\resources\vendor\yt-dlp.fresh"
    FileOpen $R2 "$INSTDIR\resources\vendor\yt-dlp.fresh" r
    FileSeek $R2 0 END $R1
    FileClose $R2
  ${EndIf}
  ${If} $R1 > 5242880
    Delete "$INSTDIR\resources\vendor\yt-dlp.exe"
    Rename "$INSTDIR\resources\vendor\yt-dlp.fresh" "$INSTDIR\resources\vendor\yt-dlp.exe"
    DetailPrint "yt-dlp updated to the latest version."
  ${Else}
    DetailPrint "Could not refresh yt-dlp — the version bundled with the installer will be used."
  ${EndIf}
  Delete "$INSTDIR\resources\vendor\yt-dlp.fresh"
!macroend

; UNINSTALL: wipes the app's data folders so a reinstall is a fresh install
; (onboarding, empty library). Electron stores userData in
; %APPDATA%\<package.json "name"> = %APPDATA%\your-player, plus the legacy
; "Afterglow Music Player" folder from before the app was renamed.
!macro customUnInstall
  RMDir /r "$APPDATA\your-player"
  RMDir /r "$APPDATA\Afterglow Music Player"
!macroend
