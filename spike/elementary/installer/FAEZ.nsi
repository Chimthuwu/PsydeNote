; PsydeNote Windows installer (NSIS 3 / Modern UI 2).
;
; Built by build-installer.sh, which supplies the defines:
;   VERSION    e.g. 0.1.0            (parsed from plugin/CMakeLists.txt)
;   OUTFILE    output .exe name       ("PsydeNote - Windows Setup v<version>.exe")
;   BUILD_DIR  plugin build artefacts (.../PsydeNote_artefacts/Release), RELATIVE to this folder
;   EXEC_LEVEL admin (default) | user  -- "user" is for unattended test installs only
;
; Installs
;   * VST3 plugin   -> %CommonProgramFiles%\VST3\PsydeNote.vst3   (what DAWs scan)
;   * Standalone    -> %ProgramFiles%\Faze\PsydeNote               (+ Start Menu / Desktop)
;   * wavetables.bin beside BOTH binaries (the plugin reads it from next to itself at runtime)
; and the Microsoft Visual C++ 2015-2022 x64 runtime when the PC lacks a recent enough one.
;
; Silent install:  "PsydeNote - Windows Setup v0.1.0.exe" /S [/NOVST3] [/NODESKTOP] [/NOVC] [/D=C:\path]   (/D must be last)

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef OUTFILE
  !define OUTFILE "PsydeNote - Windows Setup v${VERSION}.exe"
!endif
!ifndef BUILD_DIR
  !error "BUILD_DIR not defined (use build-installer.sh)"
!endif
!ifndef EXEC_LEVEL
  !define EXEC_LEVEL "admin"
!endif

!define APP_NAME   "PsydeNote"
!define PUBLISHER  "Faze"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME}"
!define APP_KEY    "Software\${PUBLISHER}\${APP_NAME}"
!define UNINSTALLER "Uninstall PsydeNote.exe"

!if "${EXEC_LEVEL}" == "user"
  !define ROOT HKCU
!else
  !define ROOT HKLM
!endif

Name "${APP_NAME} ${VERSION}"
OutFile "${OUTFILE}"
RequestExecutionLevel ${EXEC_LEVEL}
InstallDir "$PROGRAMFILES64\${PUBLISHER}\${APP_NAME}"
InstallDirRegKey ${ROOT} "${APP_KEY}" "InstallDir"
BrandingText "${APP_NAME} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP_NAME}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${APP_NAME} installer"
VIAddVersionKey "LegalCopyright" "Faze"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

!define MUI_ICON   "..\scripts\FAEZ.ico"
!define MUI_UNICON "..\scripts\FAEZ.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\PsydeNote.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Launch PsydeNote (standalone)"
!define MUI_FINISHPAGE_NOREBOOTSUPPORT

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

; ----------------------------------------------------------------------------
Section "PsydeNote VST3 plugin" SecVST3
  SetRegView 64
  SetOutPath "$COMMONFILES64\VST3\PsydeNote.vst3"
  File /r /x "*.ilk" /x "*.pdb" /x "*.exp" /x "*.lib" "${BUILD_DIR}\VST3\PsydeNote.vst3\*.*"
  WriteRegStr ${ROOT} "${APP_KEY}" "VST3Dir" "$COMMONFILES64\VST3\PsydeNote.vst3"
SectionEnd

Section "PsydeNote standalone app" SecApp
  SetRegView 64
  SetOutPath "$INSTDIR"
  File "${BUILD_DIR}\Standalone\PsydeNote.exe"
  File "${BUILD_DIR}\Standalone\wavetables.bin"
  File "..\scripts\FAEZ.ico"
  CreateDirectory "$SMPROGRAMS\${PUBLISHER}"
  CreateShortCut "$SMPROGRAMS\${PUBLISHER}\PsydeNote.lnk" "$INSTDIR\PsydeNote.exe" "" "$INSTDIR\PsydeNote.exe" 0
SectionEnd

Section "Desktop shortcut" SecDesktop
  SetRegView 64
  CreateShortCut "$DESKTOP\PsydeNote.lnk" "$INSTDIR\PsydeNote.exe" "" "$INSTDIR\PsydeNote.exe" 0
  WriteRegDWORD ${ROOT} "${APP_KEY}" "DesktopLink" 1   ; so the uninstaller only removes a link WE made
SectionEnd

; Hidden + always run: runtime check, uninstaller, Add/Remove Programs entry.
Section "-Common"
  SetRegView 64
  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\${UNINSTALLER}"
  WriteRegStr ${ROOT} "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr ${ROOT} "${APP_KEY}" "Version" "${VERSION}"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "DisplayName" "${APP_NAME}"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\FAEZ.ico"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr ${ROOT} "${UNINST_KEY}" "UninstallString" '"$INSTDIR\${UNINSTALLER}"'
  WriteRegDWORD ${ROOT} "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD ${ROOT} "${UNINST_KEY}" "NoRepair" 1

  ; Microsoft Visual C++ 2015-2022 x64 runtime (PsydeNote links it dynamically).
  ; Needs 14.44+ (the toolset it was built with); skip with /NOVC.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/NOVC" $R1
  ${If} ${Errors}
    ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Installed"
    ReadRegDWORD $1 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\x64" "Minor"
    ${If} $0 != 1
    ${OrIf} $1 < 44
      DetailPrint "Installing Microsoft Visual C++ runtime..."
      SetOutPath "$PLUGINSDIR"
      File "/oname=$PLUGINSDIR\vc_redist.x64.exe" "deps\vc_redist.x64.exe"
      ExecWait '"$PLUGINSDIR\vc_redist.x64.exe" /install /quiet /norestart' $2
      DetailPrint "VC++ runtime installer exit code: $2"
    ${Else}
      DetailPrint "Microsoft Visual C++ runtime already present."
    ${EndIf}
  ${EndIf}

  ; The plugin UI is a WebView2 page: warn (don't block) if the runtime is missing.
  ReadRegStr $3 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $3 == ""
    ReadRegStr $3 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${EndIf}
  ${If} $3 == ""
    DetailPrint "WARNING: Microsoft Edge WebView2 Runtime not found."
    MessageBox MB_OK|MB_ICONEXCLAMATION "PsydeNote's interface needs the Microsoft Edge WebView2 Runtime, which was not found on this PC.$\r$\n$\r$\nInstall it from https://developer.microsoft.com/microsoft-edge/webview2/ (Evergreen Runtime) if the plugin window stays blank." /SD IDOK
  ${EndIf}
SectionEnd

LangString DESC_VST3 ${LANG_ENGLISH} "The VST3 instrument for your DAW (installed to the shared VST3 folder)."
LangString DESC_APP ${LANG_ENGLISH} "The standalone PsydeNote application."
LangString DESC_DESKTOP ${LANG_ENGLISH} "A shortcut to the standalone app on your Desktop."
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecVST3} $(DESC_VST3)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecApp} $(DESC_APP)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_DESKTOP)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Function .onInit
  SetRegView 64
  ; Scripted installs: /NOVST3 skips the plugin component.
  ${GetParameters} $R0
  ${GetOptions} $R0 "/NOVST3" $R1
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecVST3}
  ${EndIf}
  ${GetOptions} $R0 "/NODESKTOP" $R1
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecDesktop}
  ${EndIf}
FunctionEnd

; ----------------------------------------------------------------------------
Function un.onInit
  SetRegView 64
FunctionEnd

Section "Uninstall"
  SetRegView 64
  ; Only remove the VST3 folder this installer put there.
  ReadRegStr $0 ${ROOT} "${APP_KEY}" "VST3Dir"
  ${If} $0 != ""
    RMDir /r "$0"
  ${EndIf}
  Delete "$INSTDIR\PsydeNote.exe"
  Delete "$INSTDIR\wavetables.bin"
  Delete "$INSTDIR\FAEZ.ico"
  Delete "$INSTDIR\${UNINSTALLER}"
  RMDir "$INSTDIR"
  RMDir "$PROGRAMFILES64\${PUBLISHER}"
  Delete "$SMPROGRAMS\${PUBLISHER}\PsydeNote.lnk"
  RMDir "$SMPROGRAMS\${PUBLISHER}"
  ReadRegDWORD $1 ${ROOT} "${APP_KEY}" "DesktopLink"
  ${If} $1 == 1
    Delete "$DESKTOP\PsydeNote.lnk"
  ${EndIf}
  DeleteRegKey ${ROOT} "${UNINST_KEY}"
  DeleteRegKey ${ROOT} "${APP_KEY}"
  ; User data (%APPDATA%\Faze: samples, settings) is deliberately left alone.
SectionEnd
