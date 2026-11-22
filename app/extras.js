const mediaTypes={
  jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',avif:'image/avif',bmp:'image/bmp',
  mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',mov:'video/quicktime',ogv:'video/ogg',mkv:'video/x-matroska'
};
let mediaGeneration=0,mediaURL='';
function releaseMedia(){
  mediaGeneration++;
  ui.mediaBody.querySelector('video')?.pause();
  ui.mediaBody.replaceChildren();
  if(mediaURL)URL.revokeObjectURL(mediaURL);
  mediaURL='';ui.saveMedia.disabled=true;ui.saveMedia.onclick=null;
}
ui.closeMedia.onclick=()=>ui.mediaDialog.close();
ui.mediaDialog.addEventListener('close',()=>{if(!ui.mediaDialog.open)releaseMedia();});
function saveBlob(url,name){
  const link=document.createElement('a');link.href=url;link.download=name;link.click();
}
async function readAttachment(file,current,type,active,progress){
  if(!Number.isSafeInteger(file.size)||file.size<0||file.size>16*1048576)throw Error('Некорректный размер файла');
  const parts=[];
  for(let offset=0;offset<file.size;offset+=chunkSize){
    if(session!==current||!active())return;
    progress(Math.round(100*offset/file.size));
    const {chunk}=await api('file-read',{fileId:file.id,part:offset/chunkSize},current);
    const bytes=Uint8Array.from(atob(chunk),c=>c.charCodeAt(0));
    if(bytes.length!==Math.min(chunkSize,file.size-offset))throw Error('Получена неполная часть файла');
    parts.push(bytes);
  }
  if(session===current&&active())return new Blob(parts,{type});
}
async function previewAttachment(file,current,type){
  releaseMedia();
  const generation=mediaGeneration,active=()=>ui.mediaDialog.open&&generation===mediaGeneration;
  ui.mediaTitle.textContent=file.name;ui.mediaDialog.showModal();
  try{
    const blob=await readAttachment(file,current,type,active,p=>ui.mediaBody.textContent='Загрузка · '+p+'%');
    if(!blob||!active())return;
    mediaURL=URL.createObjectURL(blob);
    ui.saveMedia.disabled=false;ui.saveMedia.onclick=()=>saveBlob(mediaURL,file.name);
    const item=document.createElement(type.startsWith('image/')?'img':'video');
    item.onerror=()=>{if(active())ui.mediaBody.textContent='Не удалось открыть этот формат. Файл можно сохранить.';};
    if(item.tagName==='VIDEO'){item.controls=true;item.playsInline=true;}else item.alt=file.name;
    ui.mediaBody.replaceChildren(item);item.src=mediaURL;
  }catch(e){if(active())ui.mediaBody.textContent='Ошибка загрузки. '+e.message;}
}
function fileButton(file,current){
  const button=document.createElement('button'),type=mediaTypes[file.name.split('.').pop().toLowerCase()];
  const preview=typeof type==='string';
  button.type='button';button.className='file-download';
  const title=(preview?'Открыть · ':'↓ ')+file.name+' · '+sizeLabel(file.size);
  button.textContent=title;
  button.onclick=action(async()=>{
    if(preview)return previewAttachment(file,current,type);
    button.disabled=true;
    try{
      const blob=await readAttachment(file,current,'application/octet-stream',()=>true,p=>button.textContent='Скачивание · '+p+'%');
      if(blob){const url=URL.createObjectURL(blob);saveBlob(url,file.name);setTimeout(()=>URL.revokeObjectURL(url),30000);}
    }finally{button.disabled=false;button.textContent=title;}
  });
  return button;
}

let personalGreeting='',greetingContext;
const greetingSources=new Set();
function stopGreetings(){for(const voice of greetingSources)voice.source.stop();greetingSources.clear();}
function showGreeting(){
  ui.pickGreeting.textContent=personalGreeting?'Заменить звук входа':'Добавить звук входа';
  ui.playGreeting.hidden=ui.clearGreeting.hidden=!personalGreeting;
}
async function playClip(encoded,current){
  if(!encoded||encoded.length>64000||!ui.greetingVolume.valueAsNumber||(current&&deafened))return;
  greetingContext??=new AudioContext();
  if(greetingContext.state==='suspended')await greetingContext.resume();
  if(current&&current!==session)return;
  const bytes=atob(encoded);
  if(!bytes.length)return;
  const buffer=greetingContext.createBuffer(1,bytes.length,16000),samples=buffer.getChannelData(0);
  for(let i=0;i<bytes.length;i++)samples[i]=(bytes.charCodeAt(i)-128)/128;
  const source=greetingContext.createBufferSource(),gain=greetingContext.createGain();
  source.buffer=buffer;source.connect(gain);gain.connect(greetingContext.destination);
  gain.gain.value=ui.greetingVolume.valueAsNumber/100;
  const voice={source,gain};greetingSources.add(voice);
  source.onended=()=>{greetingSources.delete(voice);source.disconnect();gain.disconnect();};
  source.start();
}
function receiveGreetings(ids,current){
  if(!ids?.length||!ui.greetingVolume.valueAsNumber||deafened)return;
  for(const subject of ids)api('greeting',{subject},current).then(data=>{
    if(session===current)return playClip(data.sound,current);
  }).catch(()=>{});
}
ui.pickGreeting.onclick=()=>ui.greetingFile.click();
ui.clearGreeting.onclick=()=>{personalGreeting='';showGreeting();savePreference({greeting:''});};
ui.playGreeting.onclick=action(()=>playClip(personalGreeting));
ui.greetingFile.onchange=action(async()=>{
  const file=ui.greetingFile.files[0];ui.greetingFile.value='';
  if(!file)return;
  if(file.size>8*1024*1024)throw Error('Выбери аудиофайл до 3 секунд и до 8 МиБ.');
  const ctx=new OfflineAudioContext(1,1,16000);
  let audio;
  try{audio=await ctx.decodeAudioData(await file.arrayBuffer());}catch{throw Error('Не удалось прочитать аудиофайл. Попробуй WAV или MP3.');}
  if(!audio.length||audio.length>48000)throw Error('Длительность звука входа должна быть до 3 секунд.');
  const mono=new Float32Array(audio.length);
  for(let ch=0;ch<audio.numberOfChannels;ch++){
    const samples=audio.getChannelData(ch);
    for(let i=0;i<mono.length;i++)mono[i]+=samples[i]/audio.numberOfChannels;
  }
  const bytes=Uint8Array.from(mono,v=>Math.max(0,Math.min(255,Math.round(128+127*v))));
  personalGreeting=btoa(String.fromCharCode(...bytes));showGreeting();await savePreference({greeting:personalGreeting});
});
ui.greetingVolume.oninput=()=>{
  ui.greetingPercent.textContent=ui.greetingVolume.value+'%';
  for(const {gain} of greetingSources)gain.gain.value=ui.greetingVolume.valueAsNumber/100;
};
ui.greetingVolume.onchange=()=>savePreference({greetingVolume:ui.greetingVolume.valueAsNumber});
ui.theme.onchange=()=>{document.documentElement.dataset.theme=ui.theme.value;savePreference({theme:ui.theme.value});};
const extrasReady=Promise.resolve(window.roomDevices?.prefs()).then(p=>{
  if(!p)return;
  if(['mint','ocean','dusk','amber','white','graphite','prism'].includes(p.theme)){ui.theme.value=p.theme;document.documentElement.dataset.theme=p.theme;}
  if(Number.isInteger(p.greetingVolume)){ui.greetingVolume.value=p.greetingVolume;ui.greetingVolume.oninput();}
  personalGreeting=p.greeting||'';showGreeting();
}).catch(()=>{});

api('version',{},null).then(({version})=>{
  ui.menuVersion.textContent=ui.settingsVersion.textContent='Версия '+version;
}).catch(()=>{});

window.roomDevices?.checkUpdate().then(result=>{
  const button=document.createElement('button');button.className='secondary';button.type='button';
  button.textContent=result?.state==='available'?'Доступна версия '+result.version:'Версии на GitHub';
  button.onclick=()=>window.roomDevices.openReleases();ui.settingsVersion.after(button);
  if(result?.state==='available'){const banner=button.cloneNode(true);banner.onclick=button.onclick;ui.menuVersion.after(banner);}
}).catch(()=>{});
