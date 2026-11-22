let streamSilent=false;
let meterStream, meterRequest=0;
const waveform=new Float32Array(512);
function level(stream){
  const analyser=micFilters.get(stream)?.analyser;
  if(!analyser)return 0;
  analyser.getFloatTimeDomainData(waveform);
  let energy=0;
  for(const sample of waveform)energy+=sample*sample;
  return Math.sqrt(energy/waveform.length);
}
function stopMeter(){
  meterRequest++;stopStream(meterStream);meterStream=undefined;ui.micMeter.value=0;
}
async function startMeter(){
  stopMeter();
  const generation=meterRequest;
  ui.meterHint.textContent='Подключение микрофона…';
  try{
    const stream=await preferredMic();
    if(generation!==meterRequest || !ui.micDialog.open){stopStream(stream);return;}
    meterStream=stream;ui.meterHint.textContent='';
  }catch(e){if(generation===meterRequest)ui.meterHint.textContent=e.message;}
}
ui.micDialog.addEventListener('close',stopMeter);
ui.noiseLevel.addEventListener('input',()=>{
  const filter=micFilters.get(meterStream);
  if(filter)setStrength(filter,ui.noiseLevel.value);
});
const lastSpeech=new WeakMap();
setInterval(()=>{
  if(meterStream)ui.micMeter.value=Math.max(0,1+20*Math.log10(Math.max(level(meterStream),0.001))/60);
  if(!session)return;
  const now=performance.now();
  for(const row of ui.members.children){
    const id=row.dataset.id, peer=peers.get(id);
    let amplitude=0;
    if(id===session.id)amplitude=level(microphone);
    else if(peer?.voice && peer.voice.receiver.track.readyState==='live' && !peer.voice.receiver.track.muted){
      const source=peer.voice.receiver.getSynchronizationSources()[0];
      if(source && now-source.timestamp<400)amplitude=source.audioLevel||0;
    }
    if(amplitude>0.015)lastSpeech.set(row,now);
    const speaking=now-(lastSpeech.get(row)??-Infinity)<250;
    row.classList.toggle('speaking',speaking);
    if(id===session.id)ui.selfAvatar.classList.toggle('speaking',speaking);
  }
},80);

let statsPeer, previousStats, statsBusy=false, statsEpoch=0;
function updateViewerTools(watching){
  ui.viewerTools.hidden=!watching;
  const peer=watching?peers.get(screenOwner):null;
  if(statsPeer!==peer){
    statsPeer=peer;previousStats=null;statsEpoch++;
    ui.statsValue.textContent='Сбор данных…';
  }
  if(!watching){ui.streamStats.hidden=true;ui.statsToggle.setAttribute('aria-expanded','false');}
}
ui.streamVolume.oninput=()=>{
  ui.streamPercent.value=ui.streamVolume.value+'%';
  ui.video.volume=ui.streamVolume.valueAsNumber/100;
};
ui.streamVolume.onchange=()=>savePreference({streamVolume:ui.streamVolume.valueAsNumber});
window.roomDevices?.prefs().then(p=>{
  if(Number.isInteger(p.streamVolume)){ui.streamVolume.value=p.streamVolume;ui.streamVolume.oninput();}
}).catch(()=>{});
ui.streamMute.onclick=()=>{
  streamSilent=!streamSilent;
  ui.streamMute.setAttribute('aria-pressed',String(streamSilent));
  ui.streamMute.textContent=streamSilent?'Включить звук':'Без звука';showScreen();
};
async function sampleStats(){
  if(statsBusy || ui.streamStats.hidden || !statsPeer?.screen)return;
  statsBusy=true;
  const epoch=statsEpoch;
  try{
    const reports=await statsPeer.screen.receiver.getStats();
    if(epoch!==statsEpoch)return;
    const r=[...reports.values()].find(s=>s.type==='inbound-rtp'&&s.kind==='video');
    const p=previousStats;
    if(!r || !p || p.ssrc!==r.ssrc || p.timestamp>=r.timestamp){previousStats=r;return;}
    const seconds=(r.timestamp-p.timestamp)/1000;
    const lost=Math.max(0,r.packetsLost-p.packetsLost);
    const total=r.packetsReceived-p.packetsReceived+lost;
    const emitted=r.jitterBufferEmittedCount-p.jitterBufferEmittedCount;
    const value=(n,d=0)=>Number.isFinite(n)&&n>=0?n.toFixed(d):'—';
    ui.statsValue.textContent=[
      'Видео · '+new Date().toLocaleTimeString('ru-RU'),
      'Разрешение: '+(r.frameWidth&&r.frameHeight?r.frameWidth+' × '+r.frameHeight:'—'),
      'FPS декодирования: '+value((r.framesDecoded-p.framesDecoded)/seconds,1),
      'Получено: '+value(8*(r.bytesReceived-p.bytesReceived)/seconds/1e6,2)+' Мбит/с',
      'Потери: '+value(100*lost/total,1)+' % ('+value(lost)+' пак.)',
      'Буфер видео: '+value(1000*(r.jitterBufferDelay-p.jitterBufferDelay)/emitted)+' мс'
    ].join('\n');
    previousStats=r;
  }catch{if(epoch===statsEpoch)ui.statsValue.textContent='Статистика временно недоступна';}
  finally{statsBusy=false;}
}
ui.statsToggle.onclick=()=>{
  ui.streamStats.hidden=!ui.streamStats.hidden;
  ui.statsToggle.setAttribute('aria-expanded',String(!ui.streamStats.hidden));
  previousStats=null;statsEpoch++;ui.statsValue.textContent='Сбор данных…';sampleStats();
};
setInterval(sampleStats,1000);
ui.copyStats.onclick=action(async()=>{await navigator.clipboard.writeText(ui.statsValue.textContent);notify('Показатели скопированы');});

async function refreshArchives(){
  try{
    const entries=await api('archives',{},null), old=ui.archiveSelect.value;
    ui.archiveSelect.replaceChildren(new Option('Новая комната',''));
    for(const room of entries){
      const option=new Option(room.title+' · '+new Date(room.opened).toLocaleDateString('ru-RU'),room.id);
      option.dataset.mode=room.mode;ui.archiveSelect.add(option);
    }
    ui.archiveSelect.value=entries.some(r=>r.id===old)?old:'';
    ui.archiveTitle.hidden=Boolean(ui.archiveSelect.value);
  }catch(e){notify('Не удалось прочитать список сохранённых комнат: '+e.message,true);}
}
ui.archiveSelect.onchange=()=>{
  const saved=Boolean(ui.archiveSelect.value);ui.archiveTitle.hidden=saved;
  if(saved)ui.mode.value=ui.archiveSelect.selectedOptions[0].dataset.mode;
  ui.create.querySelector('span').textContent=saved?'Открыть комнату':'Создать комнату';
};
refreshArchives();
let beforeMessage;
async function loadHistory(){
  const current=session;
  ui.historyMore.disabled=true;
  try{
    const {messages}=await api('history',{before:beforeMessage},current);
    if(session!==current||!ui.historyDialog.open)return;
    const fragment=document.createDocumentFragment();
    for(const m of messages){
      const li=document.createElement('li'),label=document.createElement('strong');
      label.textContent=m.name+' · '+new Date(m.time).toLocaleString('ru-RU');
      li.append(label,m.file?fileButton(m.file,current):document.createTextNode(m.message));
      fragment.append(li);
    }
    ui.historyRows.prepend(fragment);
    beforeMessage=messages[0]?.seq;
    ui.historyMore.hidden=!beforeMessage||beforeMessage<=1;
    if(!ui.historyRows.children.length)ui.historyRows.textContent='Сообщений пока нет';
  }finally{ui.historyMore.disabled=false;}
}
ui.historyOpen.onclick=action(async()=>{
  ui.historyRows.replaceChildren();beforeMessage=undefined;ui.historyDialog.showModal();await loadHistory();
});
ui.historyMore.onclick=action(loadHistory);
