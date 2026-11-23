const blockSize = 48 * 1024;
const maxSize = 16 * 1024 * 1024;
const quota = 64 * 1024 * 1024;
const {randomUUID} = require('node:crypto');

function attachment(room, member, req, fail) {
  const files = room.files;
  let reserved = 0;
  for (const [id,f] of files) {
    if (f.published ? !room.chat.some(m=>m.file?.id===id) : Date.now()-f.touched>120000 || !room.members.has(f.owner)) files.delete(id);
    else reserved += f.size;
  }
  if (req.op === 'file-start') {
    if (!Number.isSafeInteger(req.size) || req.size<0 || req.size>maxSize) fail('Максимальный размер файла — 16 МиБ.');
    if (reserved+req.size>quota || files.size>=128) fail('Память для файлов этой комнаты заполнена.');
    const music=req.purpose==='music';
    if(music){
      if(room.music.admins&&!member.admin)fail('Управление доступно администраторам',403);
      if(!Number.isFinite(req.duration)||req.duration<=0||req.duration>86400)fail('Некорректная длительность трека');
    }
    const id=randomUUID();
    files.set(id,{music,duration:req.duration,owner:req.id,size:req.size,name:String(req.filename||'Файл').replace(/[\\/\x00-\x1f]/g,'_').slice(0,150),parts:[],received:0,touched:Date.now()});
    return {id};
  }
  if(req.op==='file-read'){
    const chunk=room.archive.chunk(req.fileId,req.part);
    if(chunk)return {chunk};
    fail('Файл недоступен',409);
  }
  const f=files.get(req.fileId);
  if (!f) fail('Файл недоступен',409);
  if (f.owner!==req.id || f.published) fail('Передача недоступна',409);
  if(req.op==='file-cancel'){files.delete(req.fileId);return {};}
  if(req.op==='file-write'){
    if(req.part!==f.parts.length || typeof req.chunk!=='string') fail('Неверная часть файла');
    const bytes=Buffer.from(req.chunk,'base64');
    if(!bytes.length || bytes.length!==Math.min(blockSize,f.size-f.received)) fail('Некорректная длина файла');
    f.parts.push(bytes); f.received+=bytes.length; f.touched=Date.now();
    return {};
  }
  if(req.op!=='file-finish' || f.received!==f.size) fail('Файл ещё не передан');
  if(f.music){
    if(room.music.admins&&!member.admin)fail('Управление доступно администраторам',403);
    if(room.music.queue.length>=100)fail('В очереди уже 100 треков');
    const track={id:req.fileId,name:f.name,size:f.size,duration:f.duration};
    room.archive.addSong(track,Buffer.concat(f.parts));room.music.queue.push(track);
    room.music.id??=track.id;files.delete(req.fileId);return {};
  }
  const item={id:randomUUID(),name:member.name,avatarKey:member.avatarKey,time:Date.now(),file:{id:req.fileId,name:f.name,size:f.size}};
  room.archive.append(item,Buffer.concat(f.parts));room.chat.push(item);files.delete(req.fileId);
  if(room.chat.length>100)room.chat.shift();
  f.published=true;
  return {};
}
module.exports=attachment;
