!include LogicLib.nsh

!macro NSIS_HOOK_POSTINSTALL
  IfSilent vidcord_ffmpeg_done 0

  nsExec::ExecToStack '"$SYSDIR\where.exe" ffmpeg'
  Pop $0
  Pop $1
  ${If} $0 == 0
    nsExec::ExecToStack '"$SYSDIR\where.exe" ffprobe'
    Pop $0
    Pop $1
    ${If} $0 == 0
      DetailPrint "FFmpeg and ffprobe already available on PATH"
      Goto vidcord_ffmpeg_done
    ${EndIf}
  ${EndIf}

  nsExec::ExecToStack '"$SYSDIR\where.exe" winget'
  Pop $0
  Pop $1
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "FFmpeg was not found, and winget is not available to install it automatically.$\r$\n$\r$\nvidcord will show FFmpeg setup options on first launch."
    Goto vidcord_ffmpeg_done
  ${EndIf}

  MessageBox MB_YESNO|MB_ICONQUESTION \
    "FFmpeg is required for vidcord compression.$\r$\n$\r$\nInstall FFmpeg now with winget? This requires an internet connection and installs the Gyan.FFmpeg system package." \
    /SD IDNO IDNO vidcord_ffmpeg_done

  DetailPrint "Installing FFmpeg with winget"
  nsExec::ExecToLog '"$SYSDIR\cmd.exe" /C winget install --id Gyan.FFmpeg --exact --accept-package-agreements --accept-source-agreements --silent'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION \
      "FFmpeg installation did not finish successfully.$\r$\n$\r$\nvidcord will show FFmpeg setup options on first launch."
  ${EndIf}

vidcord_ffmpeg_done:
!macroend
