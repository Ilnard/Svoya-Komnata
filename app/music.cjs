function open(archive){
  const queue=archive.songs();
  return {queue,id:queue[0]?.id??null,admins:Boolean(archive.settings.musicAdmins),playing:false,position:0,at:Date.now(),revision:0};
}
function snapshot(room){
  const m=room.music,track=m.queue.find(t=>t.id===m.id);
  const position=Math.min(track?.duration||0,m.position+(m.playing?Math.max(0,Date.now()-m.at)/1000:0));
  return {queue:m.queue,id:m.id,admins:m.admins,playing:m.playing,position,revision:m.revision};
}
function command(room,member,data,fail){
  const m=room.music;
  if(data.action==='policy'){
    if(room.host!==data.id||typeof data.enabled!=='boolean')fail('Только хост может менять права',403);
    room.archive.saveMusicPolicy(data.enabled);m.admins=data.enabled;return {};
  }
  if(m.admins&&!member.admin)fail('Управление доступно администраторам',403);
  if(data.track!==m.id)fail('Трек уже сменился',409);
  const index=m.queue.findIndex(t=>t.id===m.id),track=m.queue[index];
  if(!track)fail('Очередь пуста',409);
  const position=snapshot(room).position;
  switch(data.action){
    case 'previous':m.id=m.queue[Math.max(0,index-1)].id;m.position=0;break;
    case 'play':m.position=position>=track.duration?0:position;m.playing=true;break;
    case 'pause':m.position=position;m.playing=false;break;
    case 'seek':
      if(!Number.isFinite(data.position))fail('Некорректная позиция');
      m.position=Math.min(track.duration,Math.max(0,data.position));break;
    case 'ended':
      if(data.id!==room.host||!m.playing||data.revision!==m.revision)return {};
      // Continue with the next queued track.
    case 'next':
      m.id=m.queue[index+1]?.id??track.id;m.position=0;
      if(index+1>=m.queue.length)m.playing=false;
      break;
    case 'select':
      if(!m.queue.some(t=>t.id===data.selected))fail('Трек недоступен');
      m.id=data.selected;m.position=0;m.playing=true;break;
    case 'remove':{
      const n=m.queue.findIndex(t=>t.id===data.selected);if(n<0)return {};
      room.archive.removeSong(data.selected);m.queue.splice(n,1);
      if(data.selected!==m.id)return {};
      m.id=m.queue[n]?.id??m.queue[0]?.id??null;m.position=0;
      if(!m.id)m.playing=false;break;
    }
    default:fail('Неизвестная команда плеера');
  }
  m.at=Date.now();m.revision++;return {};
}
module.exports={open,snapshot,command};