; Dark theme for the installer (colors from src/renderer/styles.css). Included before MUI2, so these win.
!define MUI_BGCOLOR 202020
!define MUI_TEXTCOLOR E6E6E6
!define MUI_HEADER_TRANSPARENT_TEXT

; Always install for the current user, like the old one-click installer: skip the "for me / all users" page.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend
