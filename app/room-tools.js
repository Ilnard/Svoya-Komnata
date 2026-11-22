let profilePhoto='';
function paintAvatar(element,photo){
  element.querySelector('img')?.remove();
  if(element.classList.contains('avatar')){element.onclick=element.onkeydown=null;element.removeAttribute('tabindex');element.removeAttribute('role');element.removeAttribute('aria-label');}
  if(!photo || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(photo))return;
  const img=document.createElement('img'); img.src=photo; img.alt='';
  element.append(img);
  if(element.classList.contains('avatar')){
    element.tabIndex=0;element.setAttribute('role','button');element.setAttribute('aria-label','Увеличить аватар');
    element.onclick=()=>{ui.avatarPicture.src=photo;ui.avatarTitle.textContent=element.closest('.member')?.querySelector('.member-name')?.textContent||ui.selfName.textContent;ui.largeAvatar.showModal();};
    element.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();element.click();}};
  }
}
function savePreference(patch){
  return window.roomDevices?.save(patch).catch(()=>notify('Не удалось записать настройки в Документы.',true));
}
function showOwnPhoto(){
  paintAvatar(ui.avatarPick,profilePhoto);
  ui.avatarClear.hidden=!profilePhoto;
}
window.roomDevices?.prefs().then(p=>{
  if(p.name && !ui.name.value) ui.name.value=p.name;
  profilePhoto=p.avatar||'';showOwnPhoto();
  if(Number.isInteger(p.noise)){ui.noiseLevel.value=p.noise;ui.noiseValue.textContent=p.noise+'%';}
  if(Number.isInteger(p.delay)){ui.playoutDelay.value=p.delay;ui.playoutDelay.oninput();}
  if(typeof p.shareAudio==='boolean')ui.shareAudio.checked=p.shareAudio;
  if(p.mode)ui.mode.value=p.mode;
}).catch(()=>notify('Не удалось прочитать профиль из Документов.',true));
ui.name.addEventListener('input',()=>savePreference({name:ui.name.value}));
ui.mode.addEventListener('change',()=>savePreference({mode:ui.mode.value}));
ui.shareAudio.addEventListener('change',()=>savePreference({shareAudio:ui.shareAudio.checked}));
ui.noiseLevel.addEventListener('change',()=>savePreference({noise:ui.noiseLevel.valueAsNumber}));
ui.playoutDelay.addEventListener('change',()=>savePreference({delay:ui.playoutDelay.valueAsNumber}));
ui.avatarPick.onclick=()=>ui.avatarFile.click();
ui.avatarClear.onclick=()=>{profilePhoto='';showOwnPhoto();savePreference({avatar:''});};
ui.avatarFile.onchange=action(async()=>{
  const file=ui.avatarFile.files[0];ui.avatarFile.value='';if(!file)return;
  const bitmap=await createImageBitmap(file);
  try {
    const canvas=document.createElement('canvas');
    const side=Math.min(bitmap.width,bitmap.height);
    for(const size of [320,240,160,96]){
      canvas.width=canvas.height=Math.min(side,size);
      canvas.getContext('2d').drawImage(bitmap,(bitmap.width-side)/2,(bitmap.height-side)/2,side,side,0,0,canvas.width,canvas.height);
      profilePhoto=canvas.toDataURL('image/jpeg',0.8);
      if(profilePhoto.length<24000)break;
    }
    showOwnPhoto();
    await savePreference({avatar:profilePhoto});
  } finally {bitmap.close();}
});
function moderationMenu(member,current){
  const menu=document.createElement('details');menu.className='moderation';
  const summary=document.createElement('summary');summary.textContent='Управление';
  summary.setAttribute('aria-label','Управление участником '+member.name);
  const list=document.createElement('div');list.className='mod-list';menu.append(summary,list);
  const choices=[];
  if(!member.admin) choices.push(['admin','Назначить администратором']);
  choices.push(member.muted?['unmute','Разрешить микрофон']:['mute','Отключить микрофон'],['kick','Исключить из комнаты']);
  for(const [value,title] of choices){
    const button=document.createElement('button');button.type='button';button.dataset.action=value;button.textContent=title;
    button.onclick=action(async()=>{menu.open=false;await api('moderate',{subject:member.id,action:value},current);});
    list.append(button);
  }
  menu.onkeydown=e=>{if(e.key==='Escape'){menu.open=false;summary.focus();}};
  return menu;
}
document.addEventListener('click',e=>document.querySelectorAll('.moderation[open]').forEach(m=>{if(!m.contains(e.target))m.open=false;}));
const chunkSize=48*1024;
const sizeLabel=n=>n<1024? n+' Б' : n<1048576?Math.ceil(n/1024)+' КиБ':(n/1048576).toFixed(1)+' МиБ';
ui.attach.onclick=()=>ui.filePick.click();
ui.filePick.onchange=action(async()=>{
  const file=ui.filePick.files[0],current=session;ui.filePick.value='';
  if(!file||!current)return;
  if(file.size>16*1048576)throw Error('Максимальный размер файла — 16 МиБ.');
  ui.attach.disabled=true;
  try{await uploadRoomFile(file,current,{},p=>ui.transferStatus.textContent='Отправка · '+p+'%');}
  finally{ui.attach.disabled=false;ui.transferStatus.textContent='';}
});
async function uploadRoomFile(file,current,extra,progress){
  let id;
  try{
    ({id}=await api('file-start',{filename:file.name,size:file.size,...extra},current));
    for(let offset=0;offset<file.size;offset+=chunkSize){
      if(session!==current)throw Error('Передача прервана.');
      progress(Math.round(offset*100/file.size));
      const bytes=new Uint8Array(await file.slice(offset,offset+chunkSize).arrayBuffer());
      await api('file-write',{fileId:id,part:offset/chunkSize,chunk:btoa(String.fromCharCode(...bytes))},current);
    }
    await api('file-finish',{fileId:id},current);
  }catch(e){if(id)await api('file-cancel',{fileId:id},current).catch(()=>{});throw e;}
}

