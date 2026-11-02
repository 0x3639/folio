; Included by electron-builder's Windows installer (build/installer.nsh is its default include).
;
; Word documents (.doc, .docx) get Folio in "Open with", which converts them to PDF. They're registered here rather
; than in package.json's fileAssociations, which would also make Folio the default app and take double-click away
; from Word.

; Restart uses --updated /S --force-run. Keep the old image from starting again while the
; uninstaller moves it aside. A write handle prevents execution, and sharing delete lets the
; uninstaller rename it. Windows releases the handle even if setup is interrupted.
!macro holdPreviousExecutable
  Var /GLOBAL previousExeHandle
  StrCpy $0 30
  ${Do}
    System::Call 'kernel32::CreateFileW(w "$INSTDIR\${APP_EXECUTABLE_FILENAME}", i 0x40000000, i 7, p 0, i 3, i 0, p 0) p.r1 ?e'
    Pop $2
    StrCpy $previousExeHandle $1
    ${If} $1 != -1
    ${OrIf} $2 != 32 ; ERROR_SHARING_VIOLATION while Folio is exiting
      ${ExitDo}
    ${EndIf}
    Sleep 100
    IntOp $0 $0 - 1
  ${LoopUntil} $0 == 0
!macroend

!macro customInit
  ${If} ${Silent}
  ${AndIf} ${isUpdated}
  ${AndIf} ${isForceRun}
    ${IfNot} ${UAC_IsInnerInstance}
      Banner::show /NOUNLOAD /set 1030 "Folio will reopen when the update finishes." "Updating Folio"
    ${EndIf}
    !insertmacro holdPreviousExecutable
  ${EndIf}
!macroend

!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument" "" "Word Document"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Folio.WordDocument\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
  WriteRegNone SHELL_CONTEXT "Software\Classes\.docx\OpenWithProgids" "Folio.WordDocument"
  WriteRegNone SHELL_CONTEXT "Software\Classes\.doc\OpenWithProgids" "Folio.WordDocument"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  ${If} ${Silent}
  ${AndIf} ${isUpdated}
  ${AndIf} ${isForceRun}
    ${If} $previousExeHandle != -1
      System::Call 'kernel32::CloseHandle(p $previousExeHandle)'
    ${EndIf}
    ; A kept Start menu shortcut can still point at a different copy.
    StrCpy $launchLink "$appExe"
    ${IfNot} ${UAC_IsInnerInstance}
      Banner::destroy
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.docx\OpenWithProgids" "Folio.WordDocument"
  DeleteRegValue SHELL_CONTEXT "Software\Classes\.doc\OpenWithProgids" "Folio.WordDocument"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Folio.WordDocument"
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
!macroend
