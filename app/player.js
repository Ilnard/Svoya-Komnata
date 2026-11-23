let hostMusic=null,musicState=null,musicSample=0,queueSignature='',scrubbing=false,uploadingSong=false;
const minutes=s=>Math.floor(s/60)+':'+String(Math.floor(s%60)).padStart(2,'0');
function musicCommand(action,extra={}){
  return api('music',{action,track:musicState?.id,...extra});
}
function endMusic(){
  if(hostMusic){
    hostMusic.audio.pause();hostMusic.audio.removeAttribute('src');hostMusic.audio.load();
    if(hostMusic.url)URL.revokeObjectURL(hostMusic.url);
    hostMusic.dest.stream.getTracks().forEach(t=>t.stop());hostMusic.ctx.close().catch(()=>{});hostMusic=null;
  }
  musicState=null;queueSignature='';scrubbing=false;ui.songQueue.replaceChildren();ui.songStatus.textContent='';
}
function predictedPosition(){
  return (musicState?.position||0)+(musicState?.playing?(performance.now()-musicSample)/1000:0);
}
function refreshPosition(){
  const track=musicState?.queue.find(t=>t.id===musicState.id);
  const progress=track?.duration ? Math.max(0,Math.min(1,(scrubbing?ui.songSeek.valueAsNumber:predictedPosition())/track.duration)) : 0;
  ui.wavePlayed.setAttribute('offset',progress);ui.waveRemaining.setAttribute('offset',progress);
  if(!track){ui.songTime.textContent='';ui.songSeek.value=0;return;}
  const pos=scrubbing?ui.songSeek.valueAsNumber:Math.min(track.duration,predictedPosition());
  if(!scrubbing)ui.songSeek.value=pos;
  ui.songTime.textContent=minutes(pos)+' / '+minutes(track.duration);
}
setInterval(()=>{if(session)refreshPosition();},200);
async function applyHostMusic(track,current){
  if(!hostMusic){
    if(!track)return;
    const ctx=new AudioContext(),audio=new Audio(),dest=ctx.createMediaStreamDestination(),gain=ctx.createGain();
    const source=ctx.createMediaElementSource(audio);
    source.connect(dest);source.connect(gain);gain.connect(ctx.destination);gain.gain.value=ui.songVolume.valueAsNumber/100;
    hostMusic={ctx,audio,dest,gain,source,id:null,revision:-1};
    for(const peer of peers.values())peer.music?.sender.replaceTrack(dest.stream.getAudioTracks()[0]).catch(()=>{});
    audio.onended=()=>{if(session===current&&musicState?.playing&&hostMusic?.id===musicState.id)musicCommand('ended',{revision:hostMusic.revision}).catch(()=>{});};
  }
  const h=hostMusic;
  if(h.id!==(track?.id??null)){
    h.id=track?.id??null;h.loaded=false;h.revision=-1;
    h.audio.onerror=null;h.audio.pause();h.audio.removeAttribute('src');h.audio.load();if(h.url)URL.revokeObjectURL(h.url);h.url='';
    if(!track)return;
    const active=()=>session===current&&hostMusic===h&&h.id===track.id&&h.loadToken===token;
    const token=h.loadToken=Symbol();
    const blob=await readAttachment(track,current,'application/octet-stream',active,()=>{});
    if(!blob||!active())return;
    h.audio.onerror=()=>{if(active()){ui.songStatus.textContent='Хост не смог воспроизвести '+track.name;if(musicState?.playing)musicCommand('pause').catch(()=>{});}};
    h.url=URL.createObjectURL(blob);h.audio.src=h.url;h.audio.load();h.loaded=true;
  }
  if(!track||!h.loaded)return;
  if(h.audio.error){if(musicState.playing&&!h.reporting){h.reporting=true;try{await musicCommand('pause');}finally{h.reporting=false;}}return;}
  if(h.audio.readyState<1)return;
  const state=musicState;
  if(!state||state.id!==h.id)return;
  const target=Math.min(h.audio.duration||track.duration,predictedPosition());
  if(h.revision!==state.revision || Math.abs(h.audio.currentTime-target)>1.25)h.audio.currentTime=target;
  h.revision=state.revision;
  if(state.playing && h.audio.paused&&!h.audio.ended){await h.ctx.resume();await h.audio.play();}
  else if(!state.playing&&!h.audio.paused)h.audio.pause();
  if(state.playing&&h.audio.ended&&!h.ending){h.ending=true;try{await musicCommand('ended',{revision:state.revision});}finally{h.ending=false;}}
}
function renderMusic(state,current){
  const m=state.music;
  ui.openMusic.hidden=!m;
  if(!m)return;
  musicState=m;musicSample=performance.now();
  const track=m.queue.find(t=>t.id===m.id),allowed=!m.admins||state.members.find(v=>v.id===current.id)?.admin;
  ui.policyRow.hidden=current.host!==current.id;ui.songPolicy.checked=m.admins;
  const filename=(track?.name||'').replace(/\.(mp3|wav|ogg|m4a|flac|aac|opus|webm)$/i,'');
  const parts=filename.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  ui.songName.textContent=parts?.[2]||filename||'Очередь пуста';ui.songArtist.textContent=parts?.[1]||'';ui.songPlay.textContent=m.playing?'Ⅱ':'▶';ui.songPlay.title=m.playing?'Пауза':'Воспроизвести';ui.songPlay.setAttribute('aria-label',ui.songPlay.title);ui.songName.title=track?.name||'';
  ui.songSeek.max=track?.duration||0;
  ui.songSeek.disabled=ui.songPlay.disabled=ui.songNext.disabled=ui.songPrevious.disabled=!track||!allowed;
  ui.addSong.disabled=!allowed||uploadingSong;
  const signature=JSON.stringify([m.queue,m.id,allowed]);
  if(signature!==queueSignature){
    queueSignature=signature;ui.songQueue.replaceChildren();
    for(const t of m.queue){
      const row=document.createElement('li'),select=document.createElement('button'),remove=document.createElement('button');
      select.textContent=(m.id===t.id?'♪ ':'')+t.name+' · '+minutes(t.duration);remove.textContent='×';remove.setAttribute('aria-label','Убрать '+t.name);
      select.disabled=remove.disabled=!allowed;select.onclick=action(()=>musicCommand('select',{selected:t.id}));remove.onclick=action(()=>musicCommand('remove',{selected:t.id}));
      row.append(select,remove);ui.songQueue.append(row);
    }
  }
  refreshPosition();
  if(current.id===current.host)applyHostMusic(track,current).catch(e=>{if(session===current)ui.songStatus.textContent='Ошибка воспроизведения: '+e.message;});
}
ui.openMusic.onclick=()=>{ui.musicDialog.showModal();refreshPosition();};
ui.songPlay.onclick=action(()=>musicCommand(musicState.playing?'pause':'play'));
ui.songPrevious.onclick=action(()=>musicCommand('previous'));
ui.songNext.onclick=action(()=>musicCommand('next'));
ui.songPolicy.onchange=action(()=>musicCommand('policy',{enabled:ui.songPolicy.checked}));
ui.songSeek.oninput=()=>{scrubbing=true;refreshPosition();};
ui.songSeek.onchange=action(async()=>{try{await musicCommand('seek',{position:ui.songSeek.valueAsNumber});}finally{scrubbing=false;}});
ui.songSeek.onpointercancel=()=>{scrubbing=false;};
ui.songVolume.oninput=()=>{
  const v=ui.songVolume.valueAsNumber/100;ui.songPercent.textContent=ui.songVolume.value+'%';
  if(hostMusic)hostMusic.gain.gain.value=v;
  for(const p of peers.values())if(p.songAudio)p.songAudio.volume=v;
};
ui.songVolume.onchange=()=>savePreference({songVolume:ui.songVolume.valueAsNumber});
function durationOf(file){
  return new Promise((resolve,reject)=>{
    const el=new Audio(),url=URL.createObjectURL(file);
    function finish(){clearTimeout(timeout);el.onloadedmetadata=el.onerror=null;el.removeAttribute('src');el.load();URL.revokeObjectURL(url);}
    function failed(){finish();reject(Error('Не удалось прочитать длительность '+file.name));}
    const timeout=setTimeout(failed,8000);
    el.onloadedmetadata=()=>{const seconds=el.duration;if(!Number.isFinite(seconds)||seconds<=0)return failed();finish();resolve(seconds);};
    el.onerror=failed;el.preload='metadata';el.src=url;
  });
}
ui.addSong.onclick=()=>ui.songFile.click();
ui.songFile.onchange=action(async()=>{
  const files=Array.from(ui.songFile.files),current=session;ui.songFile.value='';if(!current||!files.length)return;
  uploadingSong=true;ui.addSong.disabled=true;
  try{
    for(const file of files){
      if(file.size>16*1048576)throw Error('Максимальный размер трека — 16 МиБ.');
      const duration=await durationOf(file);
      if(session!==current)return;
      await uploadRoomFile(file,current,{purpose:'music',duration},p=>{ui.songStatus.textContent=file.name+' · '+p+'%';});
    }
  }finally{uploadingSong=false;ui.songStatus.textContent='';}
});
function fitSidebars(){
  const layout=document.querySelector('.room-layout'),width=layout.clientWidth;
  if(width<=800)return;
  let left=Math.min(sideWidths.peopleWidth??(width>=1440?250:width<=1050?190:226),width-420);
  const right=Math.min(sideWidths.chatWidth??(width>=1440?340:width<=1050?260:300),width-left-240);
  layout.style.setProperty('--people-size',left+'px');layout.style.setProperty('--chat-size',right+'px');
}
const sideWidths={};
function addDivider(panel,key,direction){
  const grip=document.createElement('div');grip.className='panel-grip';grip.tabIndex=0;
  grip.setAttribute('role','separator');grip.setAttribute('aria-orientation','vertical');grip.setAttribute('aria-label',key==='chatWidth'?'Ширина чата':'Ширина списка участников');panel.append(grip);
  const opposite=document.querySelector(key==='chatWidth'?'.people-panel':'.chat-panel');
  function resize(w){
    const min=key==='chatWidth'?180:140,limit=Math.min(key==='chatWidth'?1200:900,panel.parentElement.clientWidth-opposite.offsetWidth-240);
    sideWidths[key]=Math.max(min,Math.min(limit,Math.round(w)));fitSidebars();grip.setAttribute('aria-valuenow',String(panel.offsetWidth));
  }
  let startX,startWidth;
  grip.onpointerdown=e=>{if(e.button!==0)return;e.preventDefault();grip.setPointerCapture(e.pointerId);startX=e.clientX;startWidth=panel.offsetWidth;};
  grip.onpointermove=e=>{if(grip.hasPointerCapture(e.pointerId))resize(startWidth+(e.clientX-startX)*direction);};
  grip.onlostpointercapture=()=>{if(sideWidths[key])savePreference({[key]:sideWidths[key]});};
  grip.onkeydown=e=>{if(['ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();resize(panel.offsetWidth+(e.key==='ArrowRight'?16:-16)*direction);savePreference({[key]:sideWidths[key]});}};
}
addDivider(document.querySelector('.people-panel'),'peopleWidth',1);addDivider(document.querySelector('.chat-panel'),'chatWidth',-1);
new ResizeObserver(fitSidebars).observe(document.querySelector('.room-layout'));
window.roomDevices?.prefs().then(p=>{
  for(const key of ['chatWidth','peopleWidth'])if(Number.isInteger(p[key]))sideWidths[key]=p[key];
  fitSidebars();if(Number.isInteger(p.songVolume)){ui.songVolume.value=p.songVolume;ui.songVolume.oninput();}
}).catch(()=>{});

const previews=new Map();let transfers=0;
function discardPreview(card,entry){
  entry.token++;entry.loading=false;
  if(entry.url){
    if(entry.video){entry.video.pause();entry.video.removeAttribute('src');entry.video.load();}
    URL.revokeObjectURL(entry.url);entry.url='';
    card.querySelector('.inline-body').replaceChildren();
  }
}
function pumpPreviews(){
  for(const [card,e] of previews){
    if(transfers>=2)break;
    if(!e.visible||e.loading||e.url||e.failed||session!==e.current)continue;
    const token=++e.token,active=()=>card.isConnected&&token===e.token;
    e.loading=true;transfers++;
    const body=card.querySelector('.inline-body');
    readAttachment(e.file,e.current,e.type,active,p=>{body.textContent='Загрузка · '+p+'%';}).then(blob=>{
      if(!blob||!active())return;
      e.url=URL.createObjectURL(blob);
      if(e.type.startsWith('image/')){
        const button=document.createElement('button'),img=document.createElement('img');
        button.className='inline-image';button.setAttribute('aria-label','Увеличить '+e.file.name);
        button.onclick=()=>{releaseMedia();mediaURL=URL.createObjectURL(blob);ui.mediaTitle.textContent=e.file.name;const full=new Image();full.src=mediaURL;ui.mediaBody.replaceChildren(full);ui.saveMedia.disabled=false;ui.saveMedia.onclick=()=>saveBlob(mediaURL,e.file.name);ui.mediaDialog.showModal();};
        img.alt=e.file.name;img.src=e.url;button.append(img);body.replaceChildren(button);
      }else{
        const video=document.createElement('video');e.video=video;video.preload='metadata';video.playsInline=true;video.src=e.url;
        const controls=document.createElement('div');controls.className='clip-controls';
        const play=document.createElement('button'),full=document.createElement('button'),seek=document.createElement('input'),vol=document.createElement('input');
        play.textContent='▶';full.textContent='⛶';play.setAttribute('aria-label','Воспроизвести или приостановить видео');full.setAttribute('aria-label','Во весь экран');
        for(const slider of [seek,vol]){slider.type='range';slider.min=0;slider.step='0.01';}
        seek.value=0;seek.disabled=true;vol.max=1;vol.value=1;seek.setAttribute('aria-label','Перемотка видео');vol.setAttribute('aria-label','Громкость видео');
        function setSeekLimit(){
          const end=Number.isFinite(video.duration)?video.duration:(video.seekable.length?video.seekable.end(video.seekable.length-1):0);
          if(Number.isFinite(end)&&end>0){seek.max=end;seek.disabled=false;}
        }
        video.ondurationchange=video.onprogress=setSeekLimit;
        video.onloadedmetadata=()=>{
          setSeekLimit();
          // Unindexed WebM recordings can report Infinity until the last frame is located.
          if(seek.disabled&&!Number.isFinite(video.duration)){
            video.addEventListener('seeked',()=>{setSeekLimit();if(seek.disabled&&video.currentTime>0&&video.currentTime<1e8){seek.max=video.currentTime;seek.disabled=false;}video.currentTime=0;},{once:true});
            video.currentTime=1e8;
          }
        };
        video.ontimeupdate=()=>{if(!seek.matches(':active'))seek.value=video.currentTime;};
        video.onplay=()=>play.textContent='Ⅱ';video.onpause=()=>play.textContent='▶';
        play.onclick=action(()=>video.paused?video.play():video.pause());video.onclick=()=>play.click();
        full.onclick=action(()=>document.fullscreenElement?document.exitFullscreen():body.requestFullscreen());
        seek.oninput=()=>video.currentTime=seek.valueAsNumber;vol.oninput=()=>video.volume=vol.valueAsNumber;
        controls.append(play,seek,vol,full);body.replaceChildren(video,controls);
        video.onerror=()=>{if(active())body.textContent='Формат видео не поддерживается.';};
      }
    }).catch(()=>{if(active()){e.failed=true;body.textContent='Предпросмотр недоступен';body.append(fileButton(e.file,e.current));}}).finally(()=>{transfers--;if(active())e.loading=false;pumpPreviews();});
  }
}
const visiblePreviews=new IntersectionObserver(changes=>{
  for(const change of changes){
    const card=change.target,e=previews.get(card);if(!e)continue;e.visible=change.isIntersecting;
    if(!e.visible&&(!e.video||e.video.paused)&&!card.contains(document.fullscreenElement))discardPreview(card,e);
  }
  pumpPreviews();
},{root:ui.messages.parentElement,rootMargin:'120px'});
new MutationObserver(()=>{
  for(const [card,e] of previews)if(!card.isConnected){visiblePreviews.unobserve(card);discardPreview(card,e);previews.delete(card);}
}).observe(ui.messages,{childList:true});
function inlineFile(file,current){
  const type=mediaTypes[file.name.split('.').pop().toLowerCase()];
  if(typeof type!=='string')return fileButton(file,current);
  const card=document.createElement('div'),body=document.createElement('div'),link=fileButton(file,current);
  card.className='inline-media';body.className='inline-body';link.textContent=file.name+' · '+sizeLabel(file.size);
  card.append(body);previews.set(card,{file,type,current,token:0});visiblePreviews.observe(card);return card;
}
