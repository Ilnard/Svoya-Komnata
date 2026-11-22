const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID, randomBytes } = require('node:crypto');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const direct = require('./direct.cjs');

const archives=require('./archives.cjs');
const port = 47832;
let room, listener;
const discovery=require('./discovery.cjs');
function describeRoom(){
  if(!room)return null;
  return {key:room.key,name:room.archive.settings.title,count:room.members.size};
}
function announce(){
  listener=discovery.advertise(()=>({...describeRoom(),endpoint:room?.direct ? directHost.localEndpoint : undefined}));
}
let directHost, creating = false, closing = Promise.resolve(), networkError;
const bridges = new Map();
const answer = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}
async function body(req) {
  let result = '';
  req.setEncoding('utf8');
  for await (const chunk of req) {
    result += chunk.toString('utf8');
    if (result.length > 100_000) fail('Запрос слишком большой', 413);
  }
  return JSON.parse(result);
}
function remove(id) {
  bridges.get(id)?.close();
  bridges.delete(id);
  directHost?.drop(id);
  if(room.host===id){for(const socket of lanMedia.sockets.values())socket.terminate();}
  else lanMedia.sockets.get(id)?.terminate();
  if (id === room.host) {
    room.archive.close();
    listener?.close();listener=undefined;
    room = undefined;
    for (const bridge of bridges.values()) bridge.close();
    bridges.clear();
    const hostToClose = directHost;
    directHost = undefined;
    closing = hostToClose?.close() || Promise.resolve();
    return;
  }
  room.members.delete(id);
  if (room.screen === id) room.screen = null;
}
function authorize(data) {
  if (!room || data.key !== room.key) fail(networkError || 'Комната недоступна', 404);
  if (room.kicked.has(data.token)) fail('Администратор исключил тебя из комнаты',410);
  const member = room.members.get(data.id);
  if (!member || member.token !== data.token) fail('Сеанс завершён или неверный ключ участника', 404);
  return member;
}
let interfaces='', routeVersion=0;
const routeMonitor=setInterval(()=>{

  const current=Object.values(os.networkInterfaces()).flat().map(n=>n.address).sort().join('|');
  if(interfaces && interfaces!==current){routeVersion++;require('./routes.cjs').reset();for(const bridge of bridges.values())bridge.reconnect();}
  interfaces=current;
},500);
routeMonitor.unref();
const expiry = setInterval(() => {
  for (const [id, bridge] of bridges) {
    if (Date.now() - bridge.touched > 310_000) { bridge.close(); bridges.delete(id); }
  }
  if (!room) return;
  for (const [token,when] of room.kicked) if(Date.now()-when>300000) room.kicked.delete(token);
  for (const [id, member] of room.members) {
    if (Date.now() - member.seen > 300_000) remove(id);
    if (!room) break;
  }
}, 2000);
expiry.unref();
function command(data, local = false, address) {
  if (data.op === 'create') {
    if (!local) fail('Комнату создаёт локальный клиент', 403);
    if (room) fail('На этом ПК уже открыта комната', 409);
    if (!String(data.name ?? '').trim()) fail('Укажи имя');
    const archive=archives.open(data.archiveId,(String(data.title||'').trim()||String(data.name).trim()).slice(0,60),data.mode==='internet'?'internet':'lan');
    room = { archive,music:require('./music.cjs').open(archive),key: randomBytes(18).toString('hex'), members: new Map(), files:new Map(), kicked:new Map(), chat: archive.page(), screen: null };
  }
  if (!room || (data.op !== 'create' && data.key !== room.key)) fail(networkError || 'Комната недоступна', 404);
  if (data.op === 'join' || data.op === 'create') {
    const name = String(data.name ?? '').trim().slice(0, 32);
    if (!name || room.members.size >= 8) fail('Укажи имя или попробуй войти, когда освободится место');
    const id = randomUUID();
    const token = randomBytes(24).toString('hex');
    room.members.set(id, { name, token, avatar:typeof data.avatar==='string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(data.avatar) && data.avatar.length<24000 ? data.avatar : '', admin: data.op === 'create', muted: false, seen: Date.now(), signals: [], microphone: null });
    const entrant=room.members.get(id);
    entrant.address=address;entrant.admin ||= room.archive.hasAdmin(address);
    entrant.greetingEvents=[];entrant.lanRelay=data.lanRelay===true;
    if(typeof data.greeting==='string' && data.greeting.length<=64000 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.greeting) && data.greeting){
      entrant.greeting=data.greeting;
      for(const listener of room.members.values()){
        listener.greetingEvents.push(id);
        if(listener.greetingEvents.length>8)listener.greetingEvents.shift();
      }
    }
    if (data.op === 'create') room.host = id;
    return { id, token, key: room.key, host: room.host };
  }
  if(data.op==='info')return describeRoom();
  const member = authorize(data);
  member.seen = Date.now();
  if (typeof data.op==='string' && data.op.startsWith('file-')) return require('./attachments.cjs')(room,member,data,fail);
  switch (data.op) {
    case 'delete-message':
      if(!member.admin)fail('Только администратор может удалить сообщение',403);
      room.archive.deleteMessage(data.messageId);
      room.chat=room.chat.filter(m=>m.id!==data.messageId);
      return {};
    case 'music': return require('./music.cjs').command(room,member,data,fail);
    case 'history': return {messages:room.archive.page(Number.isSafeInteger(data.before)?data.before:undefined)};
    case 'greeting': return {sound:room.members.get(data.subject)?.greeting||''};
    case 'profile': return {avatar:room.members.get(data.subject)?.avatar || ''};
    case 'poll':
      member.watching = room.screen && data.id !== room.screen && data.watching === room.screenId ? room.screenId : null;
      if (Number.isSafeInteger(data.epoch)) member.epoch = data.epoch;
      member.voiceSent=Object.fromEntries(Array.from(room.members.keys()).filter(id=>Number.isSafeInteger(data.voiceSent?.[id])).map(id=>[id,data.voiceSent[id]]));
      member.retries = Object.fromEntries(Array.from(room.members.keys())
        .filter(id => Number.isSafeInteger(data.retries?.[id]))
        .map(id => [id, data.retries[id]]));
      if (typeof data.microphone === 'boolean') member.microphone = data.microphone;
      return {
        members: Array.from(room.members, ([id, m]) => ({ id, lanRelay:m.lanRelay,hasAvatar:Boolean(m.avatar), voiceSent:m.voiceSent?.[data.id], watching:m.watching, epoch:m.epoch || 0, retry:m.retries?.[data.id] || 0, name: m.name, admin:m.admin, muted:m.muted, microphone: m.muted ? false : m.microphone })),
        music:require('./music.cjs').snapshot(room),greetings:member.greetingEvents.splice(0),title:room.archive.settings.title,chat: room.chat,
        screen: room.screen,
        screenId: room.screen ? room.screenId : null,
        screenHasAudio: Boolean(room.screen && room.screenHasAudio),
        networkWarning: data.id === room.host ? networkError : undefined,
        signals: member.signals.splice(0),
      };
    case 'moderate': {
      const subject = room.members.get(data.subject);
      if (!member.admin || data.subject === room.host || data.subject === data.id) fail('Недостаточно прав', 403);
      if (!subject) fail('Участник уже вышел', 409);
      if (data.action === 'admin') {room.archive.rememberAdmin(subject.address);subject.admin = true;}
      else if (data.action === 'mute') subject.muted = true;
      else if (data.action === 'unmute') subject.muted = false;
      else if (data.action === 'kick') {room.kicked.set(subject.token,Date.now()); remove(data.subject);}
      else fail('Неизвестное действие');
      break;
    }
    case 'signal': {
      const peer = room.members.get(data.to);
      if (peer && peer.signals.length < 256) peer.signals.push({ from: data.id, payload: data.payload });
      break;
    }
    case 'chat': {
      const message = String(data.message ?? '').trim().slice(0, 1000);
      if (message) { const item={id:randomUUID(), name:member.name,message,time:Date.now()};room.archive.append(item);room.chat.push(item); }
      if (room.chat.length > 100) room.chat.shift();
      break;
    }
    case 'screen':
      if (data.active && room.screen && room.screen !== data.id) fail('В комнате уже идёт трансляция', 409);
      if (data.active) {
        room.screen = data.id;
        room.screenHasAudio = data.hasAudio === true;
        room.screenId = typeof data.screenId === 'string' && data.screenId.length <= 64 ? data.screenId : randomUUID();
      }
      else if (room.screen === data.id) room.screen = null;
      break;
    case 'leave': remove(data.id); break;
    default: fail('Неизвестная операция');
  }
  return {};
}

const host = http.createServer(async (req, res) => {
  try {
    if (req.method !== 'POST' || req.url !== '/room') fail('Страница недоступна', 404);
    if (room?.direct) fail('Для интернет-комнаты используй приглашение SK1.', 403);
    answer(res, command(await body(req),false,req.socket.remoteAddress));
  } catch (error) { answer(res, { error: error.status ? error.message : 'Некорректный запрос' }, error.status || 400); }
});
const lanMedia=direct.attachMedia(host,auth=>{
  if(!room||room.direct)fail('Недоступный медиаканал',403);
  return authorize(auth);
});
let listenError;
host.on('error', error => { listenError = error.code; });
host.listen(port, '0.0.0.0');

const files = {
  '/noise/processor.js': ['noise/processor.js', 'text/javascript'],
  '/noise/rnnoise.wasm': ['noise/rnnoise.wasm', 'application/wasm'],
  '/': ['index.html', 'text/html'],
  '/prism.js':['prism.js','text/javascript'],
  '/player.js':['player.js','text/javascript'],
  '/extras.js':['extras.js','text/javascript'],
  '/room-media.js':['room-media.js','text/javascript'],
  '/view-quality.js':['view-quality.js','text/javascript'],
  '/lobby-tools.js':['lobby-tools.js','text/javascript'],
  '/room-tools.js': ['room-tools.js','text/javascript'],
  '/app.js': ['app.js', 'text/javascript'],
  '/style.css': ['style.css', 'text/css'],
  '/icon.png': ['icon.png', 'image/png'],
  '/icon.ico': ['icon.ico', 'image/x-icon'],
};
const client = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== '127.0.0.1:' + client.address().port) fail('Недопустимый адрес', 403);
    if (req.method === 'GET' && Object.hasOwn(files, req.url)) {
      const [file, type] = files[req.url];
      res.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return res.end(fs.readFileSync(join(__dirname, file)));
    }
    if (req.method !== 'POST' || req.url !== '/api' || req.headers.origin !== 'http://' + req.headers.host) fail('Запрос отклонён', 403);
    const { target, ...data } = await body(req);
    if(data.op==='version')return answer(res,{version:require('./desktop/resources/app/package.json').version});
    if(data.op==='archives')return answer(res,archives.list());
    if(data.op==='discover')return answer(res,await discovery.discover());
    function clientResult(result,status){
      if(data.op==='poll'&&result.members)result.localRoute=routeVersion;
      return answer(res,result,status);
    }
    const activeBridge = bridges.get(data.id);
    if (activeBridge && activeBridge.credentials.token === data.token) activeBridge.touched = Date.now();
    if (data.op === 'bridge' || data.op === 'bridge-close') {
      const bridge = bridges.get(data.id);
      if (!bridge || bridge.credentials.token !== data.token) fail('Медиасеанс недоступен', 404);
      if (data.op === 'bridge-close') { bridge.remove(data.to); return answer(res, {}); }
      return answer(res, { port: await bridge.peer(data.to) });
    }
    if (data.op === 'create' && data.mode === 'internet') {
      if (creating || room) fail('Комната уже создаётся или открыта', 409);
      if (!host.listening) fail('Уже запущена другая копия приложения или занят локальный порт 47832. Закрой другую копию и запусти приложение снова.', 409);
      if (!String(data.name ?? '').trim()) fail('Укажи имя');
      creating = true;
      networkError = undefined;
      try {
        await closing;
        directHost = await direct.startHost({
          command, authorize, readBody: body, answer,
          onFailure: message => { networkError = message; },
        });
        const result = command(data, true);
        room.direct = true;announce();
        const endpoint = { ...directHost.endpoint, key: room.key };
        result.invitation = direct.encodeInvite(endpoint);
        result.direct = true;
        result.networkMessage = 'Роутер подтвердил открытие TCP-порта ' + endpoint.port + '. Доступность извне подтвердится при входе друга.';
        bridges.set(result.id, new direct.MediaBridge(directHost.localEndpoint, result));
        return clientResult(result);
      } catch (error) {
        await directHost?.close();
        directHost = undefined;
        room?.archive.close();
        room = undefined;
        throw Object.assign(error, { status: error.status || 503 });
      } finally { creating = false; }
    }
    if (typeof target === 'string' && target.startsWith('SK1.')) {
      if (bridges.get(data.id)?.hostClosed) {
        bridges.delete(data.id);
        fail('Хост закрыл комнату', 404);
      }
      const endpoint = direct.parseInvite(target);
      let result;
      try {
        result = await direct.remoteCommand(endpoint, { ...data, key: endpoint.key });
      } catch (error) {
        if (data.op === 'leave' || error.status === 404 || error.status === 410) { bridges.get(data.id)?.close(); bridges.delete(data.id); }
        if (!error.status) {
          error.status = 503;
          error.message = 'Не удалось подключиться к хосту. Проверь приглашение, интернет и брандмауэр хоста. ' + error.message;
        }
        throw error;
      }
      if (data.op === 'join') {
        result.direct = true;
        result.invitation = target;
        bridges.set(result.id, new direct.MediaBridge(endpoint, result));
      }
      if (data.op === 'leave') { bridges.get(data.id)?.close(); bridges.delete(data.id); }
      return clientResult(result);
    }
    if (!target) {
      if (data.op === 'create' && creating) fail('Комната уже создаётся', 409);
      if (data.op === 'create' && (listenError || !host.listening)) fail('TCP-порт 47832 занят или недоступен');
      const result = command(data, true);
      if (data.op === 'create') {
        if(data.lanRelay)bridges.set(result.id,new direct.MediaBridge({lan:true,address:'127.0.0.1',port:host.address().port},result));
        announce();
        result.addresses = Object.values(os.networkInterfaces()).flat()
          .filter(item => item.family === 'IPv4' && !item.internal).map(item => item.address);
      }
      return clientResult(result);
    }
    if (!/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(target) || target.split('.').some(part => Number(part) > 255 || String(Number(part)) !== part)
        || !/^[a-f0-9]{36}$/.test(data.key)) fail('Проверь адрес и код приглашения');
    try{
      const remote=await new Promise((resolve,reject)=>{
        const req=http.request({hostname:target,port,path:'/room',method:'POST',agent:require('./routes.cjs').lan,signal:AbortSignal.timeout(data.op==='poll'?2200:6500)},response=>{
          let body='';
          response.setEncoding('utf8');response.on('error',reject);
          response.on('data',part=>{body+=part;if(body.length>500000)response.destroy(Error('Слишком большой ответ'));});
          response.on('end',()=>{try{resolve({value:JSON.parse(body),status:response.statusCode});}catch(e){reject(e);}});
        });
        req.on('error',reject);req.end(JSON.stringify(data));
      });
      if(remote.status===200&&data.op==='join'&&data.lanRelay)bridges.set(remote.value.id,new direct.MediaBridge({lan:true,address:target,port},remote.value));
      if(data.op==='leave'){bridges.get(data.id)?.close();bridges.delete(data.id);}
      clientResult(remote.value,remote.status);
    }catch{fail('Хост недоступен. Проверь доступ VPN к локальной сети и адрес комнаты',503);}
  } catch (error) {
    answer(res, { error: error.status ? error.message : 'Некорректный запрос' }, error.status || 400);
  }
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (room) remove(room.host);
  for (const bridge of bridges.values()) bridge.close();
  await closing;
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('data', data => { if (data.toString().trim() === 'shutdown') shutdown(); });
process.stdin.unref?.();
client.listen(0, '127.0.0.1', () => {
  const url = 'http://127.0.0.1:' + client.address().port;
  console.log('Своя комната | ' + url);
});
