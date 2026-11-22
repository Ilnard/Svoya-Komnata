let recentRooms=[], listBusy=false, lastList='';
const prefsReady=window.roomDevices?.prefs().then(p=>{recentRooms=p.recent||[];}).catch(()=>{});
function rememberRoom(code){
  recentRooms=[code,...recentRooms.filter(item=>item!==code)].slice(0,8);
  savePreference({recent:recentRooms});
}
async function knownRoom(code){
  const direct=code.startsWith('SK1.');
  const [address,key]=code.split('/');
  const room=await api('info',{target:direct?code:address,key:direct?undefined:key},null);
  if(typeof room.name!=='string' || typeof room.key!=='string' || !Number.isInteger(room.count))return null;
  return {...room,code};
}
async function listRooms(){
  if(session||listBusy||document.hidden)return;
  listBusy=true;ui.refreshRooms.disabled=true;
  try{
    await prefsReady;
    const [near,known]=await Promise.all([
      api('discover',{},null), Promise.all(recentRooms.map(code=>knownRoom(code).catch(()=>null)))
    ]);
    if(session)return;
    const rooms=new Map();
    for(const room of [...known.filter(Boolean),...near])rooms.set(room.key,room);
    const list=[...rooms.values()];
    ui.roomListHint.textContent=list.length?'':'Открытых комнат в этой сети и по сохранённым приглашениям пока нет.';
    const snapshot=JSON.stringify(list);
    if(snapshot===lastList)return;
    lastList=snapshot;
    ui.roomList.replaceChildren(...list.map(room=>{
      const button=document.createElement('button');
      button.type='button';button.className='room-choice';button.disabled=room.count>=8;
      const name=document.createElement('strong');name.textContent='Комната · '+room.name;
      const count=document.createElement('span');count.textContent=room.count+' / 8';
      button.append(name,count);
      button.onclick=action(async()=>{ui.invite.value=room.code;await enterOnce('join');});
      return button;
    }));
  }catch{ui.roomListHint.textContent='Не удалось обновить список. Попробуй ещё раз.';}
  finally{listBusy=false;ui.refreshRooms.disabled=false;}
}
ui.refreshRooms.onclick=listRooms;
document.addEventListener('visibilitychange',listRooms);
setInterval(listRooms,5000);
listRooms();

let monitor, monitorRequest=0;
function stopVoiceTest(){
  monitorRequest++;
  if(monitor){
    monitor.ctx.close().catch(()=>{});
    stopStream(monitor.stream);
    monitor=null;
  }
  ui.voiceTest.setAttribute('aria-pressed','false');
  ui.voiceTest.textContent='Проверить голос';
}
ui.voiceTest.onclick=action(async()=>{
  if(ui.voiceTest.getAttribute('aria-pressed')==='true'){stopVoiceTest();return;}
  const current=session, request=++monitorRequest;
  if(!current)return;
  ui.voiceTest.setAttribute('aria-pressed','true');
  ui.voiceTest.textContent='Остановить проверку';
  let stream,ctx;
  try{
    stream=await preferredMic();
    if(request!==monitorRequest || session!==current)return;
    ctx=new AudioContext({latencyHint:'interactive'});
    const input=Number(ui.noiseLevel.value)===0?micFilters.get(stream)?.input||stream:stream;
    const delay=ctx.createDelay(1);delay.delayTime.value=0.5;
    ctx.createMediaStreamSource(input).connect(delay).connect(ctx.destination);
    await ctx.resume();
    if(request!==monitorRequest || session!==current)return;
    monitor={ctx,stream};
    stream.getAudioTracks()[0].onended=stopVoiceTest;
    ctx=null;stream=null;
  }catch(e){if(request===monitorRequest)stopVoiceTest();throw e;}
  finally{if(ctx)await ctx.close();if(stream)stopStream(stream);}
});
ui.voiceTest.title='Прослушивание в своих наушниках с задержкой 0,5 с';

let assigning=false, activeKey='';
function showKey(){ui.muteKey.textContent=activeKey?activeKey.replace('Control','Ctrl'):'Назначить';}
ui.openSettings.onclick=async()=>{
  ui.settingsDialog.showModal();
  if(window.roomDevices?.muteKey){
    const key=await window.roomDevices.muteKey();
    activeKey=key.active;
    ui.keyHint.textContent=key.saved && !key.active?'Сохранённое сочетание занято. Выбери другое.':'Работает и когда окно игры активно.';
  }else {ui.muteKey.disabled=ui.clearKey.disabled=true;ui.keyHint.textContent='Доступно в приложении Windows.';}
  showKey();
};
ui.closeSettings.onclick=()=>ui.settingsDialog.close();
ui.settingsDialog.onclose=()=>{assigning=false;showKey();};
ui.audioSettings.onclick=()=>ui.micSettings.click();
ui.muteKey.onclick=()=>{assigning=true;ui.muteKey.textContent='Нажми сочетание…';ui.keyHint.textContent='Ctrl, Alt или Shift + буква или цифра. Можно выбрать F1–F24. Esc — отмена.';};
async function saveKey(key){
  assigning=false;
  const ok=await window.roomDevices.setMuteKey(key);
  if(ok)activeKey=key;
  showKey();
  ui.keyHint.textContent=ok?(key?'Горячая клавиша сохранена.':'Назначение снято.'):'Сочетание занято или не удалось сохранить настройки.';
}
ui.clearKey.onclick=action(()=>saveKey(''));
document.addEventListener('keydown',e=>{
  if(!assigning)return;
  e.preventDefault();e.stopPropagation();
  if(e.key==='Escape'){assigning=false;showKey();return;}
  if(e.repeat)return;
  const mods=[e.ctrlKey?'Control':'',e.altKey?'Alt':'',e.shiftKey?'Shift':''].filter(Boolean);
  const key=e.code.replace(/^(Key|Digit)/,'');
  if(!e.metaKey && (/^F([1-9]|1[0-9]|2[0-4])$/.test(key) || (mods.length && /^[A-Z0-9]$/.test(key))))saveKey([...mods,key].join('+')).catch(()=>notify('Не удалось назначить клавишу',true));
},true);
window.roomDevices?.onMute(()=>{if(session&&!assigning&&!mediaBusy&&!adminMuted)ui.mic.click();});
