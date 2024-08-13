; Script generated by the Inno Setup Script Wizard.
; SEE THE DOCUMENTATION FOR DETAILS ON CREATING INNO SETUP SCRIPT FILES!

#define MyAppName "vidcord"
#define MyAppVersion "3.6"
#define MyAppPublisher "cyroz"
#define MyAppURL "https://github.com/cyroz1/vidcord"
#define MyAppExeName "vidcord.exe"

[Setup]
; NOTE: The value of AppId uniquely identifies this application. Do not use the same AppId value in installers for other applications.
; (To generate a new GUID, click Tools | Generate GUID inside the IDE.)
AppId={{78A01AFE-8FF8-488A-B205-063492C685C7}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
;AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DisableDirPage=yes
; "ArchitecturesAllowed=x64compatible" specifies that Setup cannot run
; on anything but x64 and Windows 11 on Arm.
ArchitecturesAllowed=x64compatible
; "ArchitecturesInstallIn64BitMode=x64compatible" requests that the
; install be done in "64-bit mode" on x64 or Windows 11 on Arm,
; meaning it should use the native 64-bit Program Files directory and
; the 64-bit view of the registry.
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
; Uncomment the following line to run in non administrative install mode (install for current user only.)
;PrivilegesRequired=lowest
OutputDir=C:\Users\cyroz\Downloads
OutputBaseFilename=vidcord_v3.6_x64
SetupIconFile=C:\Users\cyroz\Downloads\vidcord\icon.ico
Compression=lzma
SolidCompression=yes
WizardStyle=modern

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "C:\Users\cyroz\Downloads\vidcord\dist\vidcord\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\Users\cyroz\Downloads\vidcord\dist\vidcord\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
; NOTE: Don't use "Flags: ignoreversion" on any shared system files

[Registry]
;Registry data from file context.reg
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.mp4\shell\vidcord"; Flags: uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.mp4\shell\vidcord"; ValueType: string; ValueName: ""; ValueData: "Compress with vidcord"; Flags: uninsdeletevalue
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.mp4\shell\vidcord\command"; Flags: uninsdeletekeyifempty
Root: HKA; Subkey: "Software\Classes\SystemFileAssociations\.mp4\shell\vidcord\command"; ValueType: string; ValueName: ""; ValueData: "\""C:\Program Files\vidcord\vidcord.exe\"" \""%1\"""; Flags: uninsdeletevalue
;End of registry data from file context.reg

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent

