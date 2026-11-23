const { app, BrowserWindow, Menu, Tray, globalShortcut, shell, dialog, desktopCapturer, session, ipcMain } = require('electron');
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const root = path.resolve(process.resourcesPath, '../..');
const icon = path.join(root, 'icon.ico');
const preferences=require('./preferences.cjs')(app.getPath('documents'),app.getPath('userData'));
function captionOverlay(theme) {
  return {color:'#00000000',symbolColor:theme==='white'?'#202732':'#f2ecf7',height:28};
}
const gpuEnabled=preferences.get().gpu!==false;
if (!gpuEnabled) app.disableHardwareAcceleration();
let win, tray, server, origin, quitting = false;
app.setAppUserModelId('SvoyaKomnata.Desktop');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(start).catch(fatal);
}
function fatal(error) {
  if (!quitting) dialog.showErrorBox('Своя комната', String(error.message || error));
  app.quit();
}
async function start() {
  server = spawn(path.join(root, 'runtime/node.exe'), ['server.cjs', '--no-open'], { env:{...process.env,ROOM_DOCUMENTS:app.getPath('documents')},cwd: root, windowsHide: true, stdio: ['pipe','pipe','ignore'] });
  server.on('error', fatal);
  server.on('exit', () => { server = null; if (!quitting) fatal('Сервер комнаты завершил работу.'); else app.quit(); });
  const lines = createInterface({ input: server.stdout });
  for await (const line of lines) {
    origin = line.match(/http:\/\/127\.0\.0\.1:\d+$/)?.[0];
    if (origin) break;
  }
  if (!origin || quitting) return;
  let pending;
  const trusted = event => win && event.senderFrame === win.webContents.mainFrame && event.senderFrame.url === origin + '/';
  let activeKey='';
  function registerKey(key) {
    if(key===activeKey)return;
    if(key && !/^(?:(?:Control|Alt|Shift)\+){0,3}(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4]))$/.test(key))throw Error('Неподдерживаемое сочетание');
    if(key && !globalShortcut.register(key,()=>win?.webContents.send('mute:toggle')))throw Error('Сочетание занято');
    if(activeKey)globalShortcut.unregister(activeKey);
    activeKey=key;
  }
  try{registerKey(preferences.get().muteKey || '');}catch{}
  ipcMain.handle('mute:get',event=>trusted(event)?{active:activeKey,saved:preferences.get().muteKey||''}:{});
  ipcMain.handle('mute:set',(event,key)=>{
    if(!trusted(event))return false;
    const previous=activeKey;
    try{registerKey(key);preferences.save({muteKey:key});return true;}
    catch{try{registerKey(previous);}catch{}return false;}
  });
  let installerAsset, downloading = false;
  ipcMain.handle('updates:install', async (event, version) => {
    if (!trusted(event) || downloading || !installerAsset || installerAsset.version !== version)
      return { error: 'Установщик этой версии пока недоступен.' };
    downloading = true;
    try {
      const file = await require('./update.cjs').downloadInstaller(installerAsset, app.getPath('temp'),
        percent => { if (win && !win.isDestroyed()) win.webContents.send('updates:progress', percent); });
      const error = await shell.openPath(file);
      if (error) throw Error(error);
      app.quit();
      return {};
    } catch (error) {
      return { error: error.message };
    } finally {
      downloading = false;
    }
  });
  ipcMain.handle('updates:check',async event=>{
    if(!trusted(event))return null;
    try{
      const response=await fetch('https://api.github.com/repos/Ilnard/Svoya-Komnata/releases/latest',{headers:{Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(6000)});
      if(response.status===404)return {state:'none'};
      if(!response.ok)throw Error('HTTP '+response.status);
      const data=await response.json(),latest=String(data.tag_name).replace(/^v/,'');
      if(!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(latest))return {state:'none'};
      const current=require('./package.json').version.split('.').map(Number),next=latest.split('.').map(Number);
      const index=next.findIndex((n,i)=>n!==current[i]);
      const name = 'SvoyaKomnata-' + latest + '-Setup-x64.exe';
      const url = 'https://github.com/Ilnard/Svoya-Komnata/releases/download/' + data.tag_name + '/' + name;
      const asset = data.assets?.find(item => item.name === name && item.browser_download_url === url &&
        item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0 && /^sha256:[a-f0-9]{64}$/.test(item.digest));
      installerAsset = index >= 0 && next[index] > current[index] && asset
        ? { name, url, size: asset.size, digest: asset.digest, version: latest } : null;
      return {state:index>=0&&next[index]>current[index]?'available':'current',version:latest,required:index>=0&&index<2&&next[index]>current[index]};
    }catch{return {state:'unavailable'};}
  });
  ipcMain.handle('prefs:get',event=>trusted(event)?preferences.get():{});
  ipcMain.handle('prefs:set',(event,patch)=>{
    if(!trusted(event)) return;
    const valid={};
    if(typeof patch.name==='string')valid.name=patch.name.slice(0,32);
    if(typeof patch.avatar==='string' && patch.avatar.length<24000 && (patch.avatar==='' || /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(patch.avatar)))valid.avatar=patch.avatar;
    for(const [key,max] of [['noise',100],['delay',1000]]) if(Number.isInteger(patch[key]) && patch[key]>=0 && patch[key]<=max)valid[key]=patch[key];
    if(typeof patch.shareAudio==='boolean')valid.shareAudio=patch.shareAudio;
    if(['internet','lan'].includes(patch.mode))valid.mode=patch.mode;
    if(Array.isArray(patch.recent)) valid.recent=patch.recent.filter(c=>typeof c==='string' && c.length<6000).slice(0,8);
    if([144,240,360,480,720,1080].includes(patch.viewHeight))valid.viewHeight=patch.viewHeight;
    if([1,2,4,6,8].includes(patch.viewRate))valid.viewRate=patch.viewRate;
    if(Number.isInteger(patch.streamVolume)&&patch.streamVolume>=0&&patch.streamVolume<=100)valid.streamVolume=patch.streamVolume;
    if(['mint','ocean','dusk','amber','white','graphite','prism'].includes(patch.theme))valid.theme=patch.theme;
    if(Number.isInteger(patch.greetingVolume)&&patch.greetingVolume>=0&&patch.greetingVolume<=100)valid.greetingVolume=patch.greetingVolume;
    if(typeof patch.greeting==='string'&&patch.greeting.length<=64000&&/^[A-Za-z0-9+/]*={0,2}$/.test(patch.greeting))valid.greeting=patch.greeting;
    for(const [key,min,max] of [['songVolume',0,100],['peopleWidth',140,900],['chatWidth',180,1200]])if(Number.isInteger(patch[key])&&patch[key]>=min&&patch[key]<=max)valid[key]=patch[key];
    preferences.save(valid);
    if(valid.theme)win.setTitleBarOverlay(captionOverlay(valid.theme));
  });
  ipcMain.handle('gpu:get',event=>trusted(event) && gpuEnabled);
  ipcMain.handle('gpu:set',(event,gpu)=>{if(trusted(event) && typeof gpu==='boolean')preferences.save({gpu});});
  ipcMain.handle('mic:get',event=>trusted(event)?preferences.get().mic||'':'');
  ipcMain.handle('mic:set',(event,mic)=>{if(trusted(event) && typeof mic==='string')preferences.save({mic:mic.slice(0,1024)});});
  ipcMain.on('capture:choice', (event,id) => {
    if (trusted(event)) pending?.(id);
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (req, done) => {
    let finished = false;
    const finish = value => { if (!finished) { finished = true; done(value); } };
    if (!req.userGesture || req.frame?.url !== origin + '/' || !win || pending) return finish(null);
    try {
      const sources = (await desktopCapturer.getSources({types:['screen','window'],thumbnailSize:{width:320,height:180}})).filter(s => s.id !== win?.getMediaSourceId());
      if (!sources.length || !win) return finish(null);
      pending = choice => {
        pending = null;
        const source = sources.find(s => s.id === choice?.id);
        finish(source ? {video:source,...(req.audioRequested && choice.audio===true ? {audio:'loopbackWithoutChrome'} : {})} : null);
      };
      win.webContents.send('capture:list',sources.map(s => ({id:s.id,name:s.name,preview:s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL()})));
    } catch { pending = null; finish(null); }
  });
  win = new BrowserWindow({width:1280,height:820,minWidth:560,minHeight:520,icon,backgroundColor:'#101615',titleBarStyle:'hidden',titleBarOverlay:captionOverlay(preferences.get().theme),webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.removeMenu();
  win.webContents.setWindowOpenHandler(() => ({action:'deny'}));
  win.webContents.on('will-navigate',(event,url) => { if (url !== origin+'/') event.preventDefault(); });
  win.setAppDetails({appId:'SvoyaKomnata.Desktop',appIconPath:process.execPath,appIconIndex:0});
  win.on('closed', () => {win=null; app.quit();});
  tray = new Tray(icon);
  tray.setToolTip('Своя комната');
  tray.setContextMenu(Menu.buildFromTemplate([{label:'Открыть',click:() => win?.show()},{label:'Завершить приложение',click:() => app.quit()}]));
  tray.on('click',() => win?.show());
  await win.loadURL(origin);
}
app.on('before-quit', event => {
  if (!server) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  server.stdin.on('error', () => {});
  server.stdin.end('shutdown\n');
  setTimeout(() => server?.kill(), 8000).unref();
});
