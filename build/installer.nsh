; NSIS customization for the Your Player installer/uninstaller.
;
; INSTALL: never checks for running instances, never closes anything, never
; removes files — it only installs. This replaces electron-builder's default
; app-running check (the "cannot be closed / Retry" dialog) with nothing.
!macro customCheckAppRunning
!macroend

; UNINSTALL: wipes the app's data folders so a reinstall is a fresh install
; (onboarding, empty library). Electron stores userData in
; %APPDATA%\<package.json "name"> = %APPDATA%\your-player, plus the legacy
; "Afterglow Music Player" folder from before the app was renamed.
!macro customUnInstall
  RMDir /r "$APPDATA\your-player"
  RMDir /r "$APPDATA\Afterglow Music Player"
!macroend
