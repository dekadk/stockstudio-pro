!include "${__FILEDIR__}\native-messaging\extension-id.nsh"

!define SSPRO_NMH_NAME "com.stockstudiopro.license"
!define SSPRO_NMH_REG_KEY "Software\Google\Chrome\NativeMessagingHosts\com.stockstudiopro.license"
!define SSPRO_NMH_PLACEHOLDER "__STOCKSTUDIO_EXTENSION_ID_PLACEHOLDER__"

; Escapes single backslashes in a Windows path to JSON-safe double backslashes.
!macro SSPRO_ESCAPE_JSON_PATH _INPUT _OUTPUT
  Push `${_INPUT}`
  Pop $R0
  StrCpy $R1 ""
  StrLen $R2 $R0
  StrCpy $R3 0
  ${DoWhile} $R3 < $R2
    StrCpy $R4 $R0 1 $R3
    ${If} $R4 == "\"
      StrCpy $R1 "$R1\\"
    ${Else}
      StrCpy $R1 "$R1$R4"
    ${EndIf}
    IntOp $R3 $R3 + 1
  ${Loop}
  StrCpy ${_OUTPUT} $R1
!macroend

!macro NSIS_HOOK_POSTINSTALL
  CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$SMPROGRAMS\${PRODUCTNAME}.lnk"
  CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  !insertmacro SetLnkAppUserModelId "$DESKTOP\${PRODUCTNAME}.lnk"

  ; Register Chrome Native Messaging Host (HKCU only, no admin required)
  ; ONLY when a real exact 32-char Extension ID was configured at build time
  ; and stockstudio-nmh.exe is present in $INSTDIR.
  ${If} "${STOCKSTUDIO_EXTENSION_ID}" != "${SSPRO_NMH_PLACEHOLDER}"
  ${AndIf} "${STOCKSTUDIO_EXTENSION_ID}" != ""
  ${AndIf} ${FileExists} "$INSTDIR\stockstudio-nmh.exe"
    CreateDirectory "$INSTDIR\native-messaging"
    !insertmacro SSPRO_ESCAPE_JSON_PATH "$INSTDIR\stockstudio-nmh.exe" $R5

    FileOpen $R6 "$INSTDIR\native-messaging\${SSPRO_NMH_NAME}.json" w
    FileWrite $R6 '{$\r$\n'
    FileWrite $R6 '  "name": "${SSPRO_NMH_NAME}",$\r$\n'
    FileWrite $R6 '  "description": "StockStudio Pro Unified License Verification Host",$\r$\n'
    FileWrite $R6 '  "path": "$R5",$\r$\n'
    FileWrite $R6 '  "type": "stdio",$\r$\n'
    FileWrite $R6 '  "allowed_origins": [$\r$\n'
    FileWrite $R6 '    "chrome-extension://${STOCKSTUDIO_EXTENSION_ID}/"$\r$\n'
    FileWrite $R6 '  ]$\r$\n'
    FileWrite $R6 '}$\r$\n'
    FileClose $R6

    WriteRegStr HKCU "${SSPRO_NMH_REG_KEY}" "" "$INSTDIR\native-messaging\${SSPRO_NMH_NAME}.json"
  ${EndIf}
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Clean up ONLY StockStudio Pro's HKCU Native Messaging Host registration and manifest.
    DeleteRegKey HKCU "${SSPRO_NMH_REG_KEY}"
    Delete "$INSTDIR\native-messaging\${SSPRO_NMH_NAME}.json"
    RMDir "$INSTDIR\native-messaging"

    MessageBox MB_YESNO|MB_ICONQUESTION "Do you also want to remove StockStudio Pro account data and Google Flow sessions?" /SD IDNO IDNO keep_data
    RMDir /r "$LOCALAPPDATA\com.stockstudiopro.desktop"
    keep_data:
  ${EndIf}
!macroend
