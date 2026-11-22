#define AppVersion GetStringFileInfo("room\desktop\SvoyaKomnata.exe", "ProductVersion")
#define RoomVersion "0.23.3"
[Setup]
AppId=SvoyaKomnataDesktopEXE
AppName=Своя комната
AppVersion={#RoomVersion}
AppPublisher=Своя комната
DefaultDirName={localappdata}\Programs\SvoyaKomnata
DefaultGroupName=Своя комната
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
SetupArchitecture=x64
DisableWelcomePage=no
SetupIconFile=room\icon.ico
UninstallDisplayIcon={app}\app\icon.ico
OutputDir=..\outputs
OutputBaseFilename=SvoyaKomnata-{#RoomVersion}-Setup-x64
Compression=lzma2/fast
SolidCompression=yes
WizardStyle=modern
VersionInfoVersion={#RoomVersion}.0
VersionInfoDescription=Установщик приложения Своя комната
Uninstallable=not IsPortable
SetupLogging=yes
[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
[Files]
Source: "room\*"; DestDir: "{app}\app"; Excludes: "\SvoyaKomnata.exe,Launcher.cs,icon-prompt.txt,port-mapping.state.json"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Своя комната"; Filename: "{app}\app\desktop\SvoyaKomnata.exe"; WorkingDir: "{app}\app\desktop"; IconFilename: "{app}\app\icon.ico"; AppUserModelID: "SvoyaKomnata.Desktop"; Check: not IsPortable
[Run]
Filename: "{app}\app\desktop\SvoyaKomnata.exe"; WorkingDir: "{app}\app\desktop"; Description: "Запустить «Своя комната»"; Flags: postinstall nowait skipifsilent
[Code]
function IsPortable: Boolean;
begin
  Result := ExpandConstant('{param:PORTABLE|0}') = '1';
end;

var
  RemoveUserSettings: Boolean;

function InitializeUninstall(): Boolean;
var
  Form: TSetupForm;
  Choice: TNewCheckBox;
  AcceptButton, CancelButton: TNewButton;
begin
  Result := True;
  RemoveUserSettings := False;
  if UninstallSilent then Exit;
  Form := CreateCustomForm(380, 110, False, True);
  try
    Form.Caption := 'Удаление приложения «Своя комната»';
    Form.ClientWidth := ScaleX(380);
    Form.ClientHeight := ScaleY(110);
    Choice := TNewCheckBox.Create(Form);
    Choice.Parent := Form;
    Choice.SetBounds(ScaleX(16), ScaleY(16), ScaleX(350), ScaleY(26));
    Choice.Caption := 'Удалить пользовательские настройки и профиль';
    Choice.Checked := False;
    AcceptButton := TNewButton.Create(Form);
    AcceptButton.Parent := Form;
    AcceptButton.SetBounds(ScaleX(162), ScaleY(64), ScaleX(100), ScaleY(28));
    AcceptButton.Caption := 'Продолжить';
    AcceptButton.ModalResult := mrOk;
    AcceptButton.Default := True;
    CancelButton := TNewButton.Create(Form);
    CancelButton.Parent := Form;
    CancelButton.SetBounds(ScaleX(270), ScaleY(64), ScaleX(92), ScaleY(28));
    CancelButton.Caption := 'Отмена';
    CancelButton.ModalResult := mrCancel;
    CancelButton.Cancel := True;
    Result := Form.ShowModal = mrOk;
    RemoveUserSettings := Result and Choice.Checked;
  finally
    Form.Free;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Dir: String;
begin
  if (CurUninstallStep = usPostUninstall) and RemoveUserSettings then begin
    Dir := ExpandConstant('{userdocs}\Своя комната');
    if FileExists(Dir+'\settings.json') and not DeleteFile(Dir+'\settings.json') then
      MsgBox('Не удалось удалить '+Dir+'\settings.json', mbError, MB_OK);
    DeleteFile(Dir+'\settings.json.tmp');
    RemoveDir(Dir);
    { Earlier versions stored these two preferences under Electron userData. }
    DeleteFile(ExpandConstant('{userappdata}\Своя комната\gpu.json'));
    DeleteFile(ExpandConstant('{userappdata}\Своя комната\microphone.json'));
  end;
end;
