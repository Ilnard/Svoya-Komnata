const ui = Object.fromEntries(Array.from(document.querySelectorAll('[id]'), el => [el.id, el]));
const peers = new Map();
let session, microphone, display, screenOwner, pollTimer, chatSnapshot;
let presentationId, watchingId, presentationHasAudio;
let mediaBusy = false, connectionLostAt;
let adminMuted = false;
let micLabel = '';
const micFilters = new WeakMap();
let noiseBinary;
function setStrength(filter, value) {
  const wet = Number(value) / 100;
  filter.wet.gain.setTargetAtTime(wet,filter.ctx.currentTime,0.01);
  filter.dry.gain.setTargetAtTime(1-wet,filter.ctx.currentTime,0.01);
}
function stopStream(stream) {
  const filter = micFilters.get(stream);
  if (filter) {
    filter.processor.port.postMessage('destroy');
    filter.input.getTracks().forEach(t => t.stop());
    filter.ctx.close().catch(() => {});
    micFilters.delete(stream);
  }
  stream?.getTracks().forEach(t => t.stop());
}
async function filterMic(input) {
  const ctx = new AudioContext({sampleRate:48000,latencyHint:'interactive'});
  try {
    noiseBinary ??= fetch('/noise/rnnoise.wasm').then(r => {
      if (!r.ok) throw Error('Не удалось загрузить модель шумоподавления');
      return r.arrayBuffer();
    }).catch(e => {noiseBinary = undefined; throw e;});
    const [wasmBinary] = await Promise.all([noiseBinary,ctx.audioWorklet.addModule('/noise/processor.js'),ctx.resume()]);
    const source = ctx.createMediaStreamSource(input);
    const processor = new AudioWorkletNode(ctx,'@sapphi-red/web-noise-suppressor/rnnoise',{channelCount:1,channelCountMode:'explicit',outputChannelCount:[1],processorOptions:{maxChannels:1,wasmBinary}});
    const wet = ctx.createGain(), dry = ctx.createGain(), delay = ctx.createDelay();
    // Worklet block alignment (512 samples) plus RNNoise's overlap frame (480).
    delay.delayTime.value = 992/48000;
    const out = ctx.createMediaStreamDestination();
    out.channelCount = 1;
    source.connect(processor).connect(wet).connect(out);
    source.connect(delay).connect(dry).connect(out);
    const analyser=ctx.createAnalyser();analyser.fftSize=512;wet.connect(analyser);dry.connect(analyser);
    const filter = {ctx,wet,dry,input,processor,analyser};
    micFilters.set(out.stream,filter);
    setStrength(filter,ui.noiseLevel.value);
    input.getAudioTracks()[0].addEventListener('ended',() => {
      const track = out.stream.getAudioTracks()[0];
      stopStream(out.stream);
      track.onended?.();
    },{once:true});
    return out.stream;
  } catch (error) {
    await ctx.close();
    input.getTracks().forEach(t => t.stop());
    throw error;
  }
}
const micPreference = window.roomDevices?.getMic().then(label => {micLabel = label;}).catch(() => {});
async function micDevices() {
  return (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
}
async function captureMic(deviceId, probeOnly = false) {
  const audio = {channelCount:1, latency:{ideal:0.01}, echoCancellation:true, noiseSuppression:false};
  if (deviceId) audio.deviceId = {exact:deviceId};
  const input = await navigator.mediaDevices.getUserMedia({audio});
  return probeOnly ? input : filterMic(input);
}
async function preferredMic() {
  await micPreference;
  if (!micLabel) return captureMic();
  let devices = await micDevices();
  if (!devices.some(d => d.label)) {
    const probe = await captureMic(null,true);
    try { devices = await micDevices(); } finally { probe.getTracks().forEach(t => t.stop()); }
  }
  const selected = devices.find(d => d.label === micLabel);
  if (!selected) throw Error('Выбранный микрофон недоступен. Выбери устройство в разделе «Вход звука».');
  return captureMic(selected.deviceId);
}
function watchMic(stream) {
  stream.getAudioTracks()[0].onended = () => {
    if (microphone !== stream) return;
    microphone = undefined;
    updateControls();
    notify('Микрофон отключён', true);
    Promise.all(Array.from(peers.values(), syncTracks)).catch(error => notify(error.message, true));
  };
}
const status = (message, state = 'ready') => { ui.status.textContent = message; ui.status.parentElement.dataset.state = state; };
const icons = {
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  'mic-off': '<path d="m3 3 18 18M9 9v3a3 3 0 0 0 5 2M9 5V4a3 3 0 0 1 6 0v7M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3m-4 0h8"/>',
  chat: '<path d="M21 11a9 9 0 0 1-9 9H4l-2 2V11a9 9 0 0 1 19 0Z"/><path d="M7 8h10M7 12h7"/>',
  screen: '<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M8 21h8M12 16v5"/>',
  headphones: '<path d="M3 14v-3a9 9 0 0 1 18 0v3"/><rect x="3" y="12" width="4" height="9" rx="2"/><rect x="17" y="12" width="4" height="9" rx="2"/>',
  network: '<rect x="8" y="2" width="8" height="6" rx="1"/><path d="M12 8v5M5 13h14M5 13v3M19 13v3"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  enter: '<path d="M14 4h6v16h-6M3 12h12m-5-5 5 5-5 5"/>',
  'user-plus': '<circle cx="9" cy="7" r="4"/><path d="M2 21v-2a7 7 0 0 1 12-5M19 12v8m-4-4h8"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
  send: '<path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2"/>',
  hangup: '<path d="M2 12a17 17 0 0 1 20 0v5h-5v-4a13 13 0 0 0-10 0v4H2v-5Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
};
function setIcon(element, name) {
  element.dataset.icon = name;
  // Only static paths from this file are inserted into SVG markup.
  element.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
}
document.querySelectorAll('[data-icon]').forEach(element => setIcon(element, element.dataset.icon));
let toastTimer, deafened = false;
function notify(message, error = false) {
  ui.toast.textContent = message;
  ui.toast.dataset.error = error;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, error ? 6500 : 3000);
  if (!session && error) {
    ui.lobbyError.textContent = message;
    ui.lobbyError.hidden = false;
  }
}
function avatar(name, photo) {
  const element = document.createElement('span');
  element.className = 'avatar';
  element.textContent = Array.from(name.trim())[0]?.toUpperCase() || '?';
  element.style.setProperty('--hue', Array.from(name).reduce((hash, char) => hash + char.codePointAt(0), 0) % 360);
  if(photo) paintAvatar(element,photo);
  return element;
}
function updateControls() {
  const micOn = Boolean(microphone?.getAudioTracks().some(track => track.readyState === 'live'));
  ui.mic.setAttribute('aria-pressed', micOn);
  ui.mic.title = micOn ? 'Выключить микрофон' : 'Включить микрофон';
  ui.mic.setAttribute('aria-label', ui.mic.title);
  setIcon(ui.mic.querySelector('i'), micOn ? 'mic' : 'mic-off');
  ui.selfStatus.textContent = micOn ? 'Микрофон включён' : 'Микрофон выключен';
  ui.stageCaption.textContent = micOn ? 'Микрофон включён. Тебя слышат участники звонка.' : 'Микрофон выключен. Включи его, когда будешь готов.';
  ui.screen.setAttribute('aria-pressed', Boolean(display));
  ui.screen.querySelector('span').textContent = display ? 'Остановить показ' : 'Показать экран';
  ui.screen.disabled = mediaBusy || Boolean(screenOwner && screenOwner !== session?.id);
  ui.stageShare.disabled = ui.screen.disabled;
  ui.screen.hidden=!display;
  ui.stageShare.hidden = Boolean(screenOwner);
  ui.mic.disabled = mediaBusy || adminMuted;
  if (adminMuted) ui.selfStatus.textContent = 'Микрофон отключён администратором';
}
function updateInvitation() {
  ui.inviteCode.value = session.invitation || (session.target || ui.address.value) + '/' + session.key;
}

async function api(op, extra = {}, current = session) {
  const response = await fetch('/api', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...current, ...extra, op }),
  });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status });
  return result;
}
function signal(id, payload, current) {
  if (payload.description) {
    // Bundled audio transceivers share one Opus payload type and its parameters.
    const sdp = payload.description.sdp.replace(/(a=fmtp:\d+ [^\r\n]*\buseinbandfec=1[^\r\n]*)/g,
      '$1;stereo=1;maxaveragebitrate=128000');
    payload = {description:{type:payload.description.type,sdp}};
  }
  return api('signal', { to:id, payload:{...payload,generation:current.generations.get(id)} }, current);
}
function closePeer(peer) {
  peer.pc.close();
  peer.audio.remove();peer.songAudio?.remove();

}
async function syncTracks(peer) {
  await Promise.all([
    peer.music?.sender.replaceTrack(hostMusic?.dest.stream.getAudioTracks()[0]??null),
    peer.voice?.sender.replaceTrack((Number(ui.noiseLevel.value) === 0 ? micFilters.get(microphone)?.input : microphone)?.getAudioTracks()[0] ?? null),
    peer.screen?.sender.replaceTrack(display && peer.watching === display.id ? display.getVideoTracks()[0] : null),
    peer.system?.sender.replaceTrack(display && peer.watching === display.id ? display.getAudioTracks()[0] ?? null : null),
  ]);
}
async function tuneVideo(peer) {
  for (const transceiver of [peer.voice, peer.system]) {
    if (!transceiver) continue;
    const audio = transceiver.sender.getParameters();
    if (!audio.encodings?.length) continue;
    audio.encodings[0].priority = 'high';
    await transceiver.sender.setParameters(audio).catch(() => {});
  }
  const sender = peer.screen?.sender;
  if (!sender || !peer.pc.currentLocalDescription) return;
  const params = sender.getParameters();
  if (!params.encodings?.length) return;
  params.degradationPreference = 'maintain-framerate';
  params.encodings[0].maxFramerate = 60;
  params.encodings[0].maxBitrate = 4_000_000;
  await sender.setParameters(params);
}
function showScreen() {
  const local = screenOwner && screenOwner === session?.id;
  const peer = peers.get(screenOwner);
  const watching = Boolean(screenOwner && !local && presentationId && watchingId === presentationId);
  const stream = local ? display : watching ? peer?.presentation : null;
  ui.watchStart.hidden = !screenOwner || local || watching;
  ui.watchStop.hidden = !watching;
  const track = stream?.getVideoTracks()[0];
  ui.delayControl.hidden = !track || local || !('jitterBufferTarget' in RTCRtpReceiver.prototype);
  updateViewRequest(watching,peer);
  ui.video.muted = Boolean(!watching || deafened || streamSilent);
  ui.video.volume = ui.streamVolume.valueAsNumber/100;
  updateViewerTools(watching);
  if (ui.video.srcObject !== (track ? stream : null)) {
    ui.video.srcObject = track ? stream : null;
    if (track) ui.video.play().catch(() => {});
  }
  ui.video.hidden = !track;
  ui.streamEmpty.hidden = watching || Boolean(track);
  ui.fullscreen.hidden = !track;
  ui.streamLabel.textContent = screenOwner ? 'Идёт демонстрация' : 'Вы в комнате';
}
async function createPeer(id, current) {
  const bridge = current.direct ? await api('bridge', { to: id }, current) : null;
  if (session !== current) return null;
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', iceServers: [] });
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.volume=current.volumes.get(id)??1;
  audio.muted = deafened;
  document.body.append(audio);
  const peer = { pc, audio, presentation:new MediaStream(), group:new MediaStream(), candidates:[], bridge, generation:current.generations.get(id), started:Date.now() };
  peers.set(id, peer);
  pc.ontrack = ({track, transceiver, streams}) => {
    if (pc.getTransceivers().indexOf(transceiver) === 0) {
      if ('jitterBufferTarget' in transceiver.receiver) transceiver.receiver.jitterBufferTarget = 20;
      audio.srcObject = new MediaStream([track]);
      audio.play().catch(() => {});
    } else if(pc.getTransceivers().indexOf(transceiver)===3){
      if(id!==current.host)return;
      const player=peer.songAudio??=document.createElement('audio');
      player.autoplay=true;player.volume=ui.songVolume.valueAsNumber/100;player.srcObject=new MediaStream([track]);player.play().catch(()=>{});
    } else {
      if ('jitterBufferTarget' in transceiver.receiver) transceiver.receiver.jitterBufferTarget = ui.playoutDelay.valueAsNumber || null;
      if (streams.length) peer.presentation = streams[0];
      else peer.presentation.addTrack(track);
      track.addEventListener('unmute', showScreen);
      showScreen();
    }
  };
  pc.onicecandidate = ({ candidate }) => {
    if (candidate && !current.direct && session === current) signal(id, { candidate }, current).catch(error => notify(error.message, true));
  };
  return peer;
}
ui.playoutDelay.oninput = () => {
  const ms = ui.playoutDelay.valueAsNumber;
  ui.delayValue.textContent = ms ? ms + ' мс' : 'Авто';
  ui.playoutDelay.setAttribute('aria-valuetext',ui.delayValue.textContent);
};
ui.playoutDelay.onchange = () => {
  const ms = ui.playoutDelay.valueAsNumber;
  for (const peer of peers.values()) {
    for (const receiver of peer.pc.getReceivers()) {
      if ('jitterBufferTarget' in receiver && peer.presentation.getTracks().includes(receiver.track)) receiver.jitterBufferTarget = ms || null;
    }
  }
};
async function offer(id, current, peer) {
  peer.voice = peer.pc.addTransceiver('audio');
  peer.screen = peer.pc.addTransceiver('video',{streams:[peer.group]});
  peer.system = peer.pc.addTransceiver('audio',{streams:[peer.group]});
  peer.music=peer.pc.addTransceiver('audio');
  await syncTracks(peer);
  await peer.pc.setLocalDescription(await peer.pc.createOffer());
  await signal(id, { description: peer.pc.localDescription }, current);
}
async function receive(peer, from, payload, current) {
  const { pc } = peer;
  if (payload.viewRequest) {
    await applyViewRequest(peer,from,payload.viewRequest,current).catch(()=>{});
    return;
  }
  if (payload.viewAck){acceptViewAck(peer,payload.viewAck);return;}
  if (payload.description) {
    const description = { ...payload.description };
    if (current.direct) {
      description.sdp = description.sdp.split('\r\n').filter(line => !line.startsWith('a=candidate:') && line !== 'a=end-of-candidates').join('\r\n');
    }
    await pc.setRemoteDescription(description);
    if (peer.bridge) {
      await pc.addIceCandidate({ candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 ' + peer.bridge.port + ' typ host', sdpMLineIndex: 0 });
    }
    for (const candidate of peer.candidates.splice(0)) await pc.addIceCandidate(candidate);
    if (payload.description.type === 'offer') {
      [peer.voice, peer.screen, peer.system, peer.music] = pc.getTransceivers();
      if(peer.music)peer.music.direction='sendrecv';
      if (peer.system) { peer.system.direction = 'sendrecv'; peer.system.sender.setStreams(peer.group); }
      peer.screen.sender.setStreams(peer.group);
      peer.voice.direction = 'sendrecv';
      peer.screen.direction = 'sendrecv';
      await syncTracks(peer);
      await pc.setLocalDescription(await pc.createAnswer());
      await signal(from, { description: pc.localDescription }, current);
    }
    await tuneVideo(peer).catch(() => {});
  } else if (payload.candidate) {
    if (pc.remoteDescription) await pc.addIceCandidate(payload.candidate);
    else peer.candidates.push(payload.candidate);
  }
}
function render(state, current) {
  receiveGreetings(state.greetings,current);renderMusic(state,current);
  const me = state.members.find(m => m.id === current.id);
  adminMuted = Boolean(me?.muted);
  if (adminMuted && microphone) {
    stopStream(microphone);
    microphone = undefined;
    Promise.all(Array.from(peers.values(), syncTracks)).catch(error => notify(error.message, true));
  }
  ui.memberCount.textContent = state.members.length + ' / 8';
  const host = state.members.find(member => member.id === current.host);
  ui.roomTitle.textContent = host ? 'Комната · ' + (state.title||host.name) : 'Своя комната';
  ui.stageTitle.textContent = screenOwner ? 'Экран · ' + (state.members.find(member => member.id === screenOwner)?.name || 'Участник') : 'Ваша встреча';
  ui.streamHint.textContent = screenOwner ? (watchingId === presentationId ? 'Ждём видеопоток от участника.' : 'Можно продолжить разговор или подключиться к просмотру.') : state.members.length > 1 ? 'Общайтесь голосом или покажите, что у вас на экране.' : 'Пригласи друзей, чтобы начать разговор.';
  const existing = new Map(Array.from(ui.members.children, el => [el.dataset.id, el]));
  for (const member of state.members) {
    let row = existing.get(member.id);
    if (!row) {
      row = document.createElement('li');
      row.className = 'member';
      row.classList.toggle('is-self', member.id === current.id);
      row.dataset.id = member.id;
      const main = document.createElement('div');
      main.className = 'member-main';
      const identity = document.createElement('div');
      identity.className = 'member-identity';
      const label = document.createElement('strong');
      label.className = 'member-name';
      label.textContent = member.name;
      label.title = member.name;
      const role = document.createElement('span');
      role.className = 'member-role';
      role.textContent = [member.id === current.id ? 'Это ты' : 'Участник', member.id === current.host ? 'Хост' : ''].filter(Boolean).join(' · ');
      identity.append(label, role);
      const stateIcon = document.createElement('i');
      stateIcon.className = 'member-state';
      const face=avatar(member.name);
      main.append(face, identity, stateIcon);
      if(member.hasAvatar) api('profile',{subject:member.id},current).then(p=>paintAvatar(face,p.avatar)).catch(()=>{});
      row.append(main);
      const peer = peers.get(member.id);
      if (peer) {
        const volumeRow = document.createElement('div');
        volumeRow.className = 'volume';
        const volume = document.createElement('input');
        volume.type = 'range';
        volume.min = 0;
        volume.max = 100;
        volume.value = Math.round(peer.audio.volume*100);
        volume.setAttribute('aria-label', 'Громкость голоса · ' + member.name);
        const output = document.createElement('output');
        output.textContent = volume.value+'%';
        volume.oninput = () => {
          peer.audio.volume = Number(volume.value) / 100;
          current.volumes.set(member.id,peer.audio.volume);

          output.textContent = volume.value + '%';
        };
        volumeRow.append(volume, output);
        row.append(volumeRow);
      }
      ui.members.append(row);
    }
    const peer = peers.get(member.id);
    if (peer) {
      peer.audio.muted = deafened || Boolean(member.muted);

    }
    row.querySelector('.member-role').textContent = [member.admin ? 'Администратор' : 'Участник', member.id === current.host ? 'Хост' : '', member.id === current.id ? 'Ты' : '', member.muted ? 'Микрофон заблокирован' : ''].filter(Boolean).join(' · ');
    const signature = [me?.admin,member.admin,member.muted].join('/');
    if (row.dataset.controls !== signature) {
      row.dataset.controls = signature;
      const previousMenu = row.querySelector('.moderation');
      const menuWasOpen = previousMenu?.open;
      previousMenu?.remove();
      if (me?.admin && member.id !== current.id && member.id !== current.host) {
        const menu = moderationMenu(member,current);
        menu.open = Boolean(menuWasOpen);
        row.append(menu);
      }
    }
    const micOn = member.id === current.id ? Boolean(microphone) : member.microphone;
    const stateIcon = row.querySelector('.member-state');
    const iconName = micOn == null ? 'headphones' : micOn ? 'mic' : 'mic-off';
    if (stateIcon.dataset.icon !== iconName) setIcon(stateIcon, iconName);
    stateIcon.classList.toggle('active', micOn === true);
    stateIcon.title = micOn == null ? 'Участник звонка' : micOn ? 'Микрофон включён' : 'Микрофон выключен';
    stateIcon.setAttribute('aria-label', stateIcon.title);
    existing.delete(member.id);
  }
  for (const row of existing.values()) row.remove();
  const snapshot = JSON.stringify(state.chat);
  if (chatSnapshot !== snapshot) {
    chatSnapshot = snapshot;
    const scroller = ui.messages.parentElement;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 70;
    ui.chatEmpty.hidden = state.chat.length > 0;
    // Preserve existing messages so live regions announce only new messages.
    const messageRows = new Map(Array.from(ui.messages.children, row => [row.dataset.key, row]));
    const activeKeys = new Set();
    for (const message of state.chat) {
      const key = message.id || JSON.stringify(message);
      activeKeys.add(key);
      if (messageRows.has(key)) continue;
      const row = document.createElement('li');
      row.className = 'chat-message';
      row.dataset.key = key;
      const body = document.createElement('div');
      body.className = 'message-body';
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const author = document.createElement('strong');
      author.textContent = message.name;
      const time = document.createElement('time');
      time.dateTime = new Date(message.time).toISOString();
      time.textContent = new Date(message.time).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
      const text = document.createElement('p');
      text.className = 'message-text';
      text.textContent = message.message;
      meta.append(author, time);
      const remove=document.createElement('button');remove.className='delete-message';remove.title='Удалить сообщение';remove.setAttribute('aria-label','Удалить сообщение');remove.textContent='×';
      remove.onclick=action(()=>api('delete-message',{messageId:message.id},current));meta.append(remove);
      body.append(meta, message.file ? inlineFile(message.file,current) : text);
      row.append(avatar(message.name), body);
      ui.messages.append(row);
    }
    for (const [key, row] of messageRows) if (!activeKeys.has(key)) row.remove();
    if (atBottom) scroller.scrollTop = scroller.scrollHeight;
  }
  for(const button of ui.messages.querySelectorAll('.delete-message'))button.hidden=!me?.admin;
  updateControls();
}
async function poll(current) {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  try {
    const state = await api('poll', { watching:watchingId || null, epoch:current.epoch, microphone:Boolean(microphone) }, current);
    connectionLostAt = undefined;
    if (session !== current) return;
    const active = new Set(state.members.map(member => member.id));
    for (const m of state.members) {
      const local = current.epoch + '.' + (current.retries[m.id] || 0);
      const remote = (m.epoch || 0) + '.' + (m.retry || 0);
      current.generations.set(m.id, current.id < m.id ? local+'/'+remote : remote+'/'+local);
    }
    for (const [id, peer] of peers) {
      if (!active.has(id) || peer.generation !== current.generations.get(id)) {
        closePeer(peer);
        peers.delete(id);
        Array.from(ui.members.children).find(row => row.dataset.id === id)?.remove();
        if (current.direct) await api('bridge-close', { to: id }, current);
      }
    }
    for (const { id } of state.members) {
      if (id === current.id || peers.has(id)) continue;
      const peer = await createPeer(id, current);
      if (!peer) return;
      if (current.id < id) await offer(id, current, peer);
    }
    for (const { from, payload } of state.signals) {
      if (session !== current) return;
      const peer = peers.get(from);
      if (peer && (!payload.generation || peer.generation === payload.generation)) await receive(peer, from, payload, current);
    }
    if (session !== current) return;
    for (const [id, peer] of peers) {
      if (peer.pc.connectionState === 'connected') peer.started = Date.now();
      else if (peer.pc.connectionState==='failed' || (peer.pc.connectionState==='disconnected' && Date.now()-peer.started>800) || Date.now()-peer.started > 6000) current.retries[id] = (current.retries[id] || 0) + 1;
    }
    screenOwner = state.screen;
    presentationId = state.screenId || state.screen;
    presentationHasAudio = state.screenHasAudio;
    if (watchingId !== presentationId) watchingId = undefined;
    for (const member of state.members) {
      const peer = peers.get(member.id);
      if (peer && peer.watching !== member.watching) {
        peer.watching = member.watching;
        await syncTracks(peer);
      }
    }
    if (session !== current) return;
    if (current.id === current.host && state.networkWarning !== undefined) {
      ui.networkMessage.hidden = !state.networkWarning;
      ui.networkMessage.textContent = state.networkWarning;
    }
    showScreen();
    render(state, current);
    const linked = Array.from(peers.values()).filter(peer => peer.pc.connectionState === 'connected').length;
    status(peers.size ? (linked === peers.size ? 'Вы на связи' : 'Подключение · ' + linked + ' из ' + peers.size) : 'Ожидание друзей', linked < peers.size ? 'waiting' : 'ready');
  } catch (error) {
    if (session !== current) return;
    if (!connectionLostAt) current.epoch++;
    connectionLostAt ??= Date.now();
    if(error.status===410){reset();ui.kicked.showModal();return;}
    if (error.status === 404 || error.status === 403) {
      reset();
      notify('Комната закрыта или хост недоступен. ' + error.message, true);
    }
    if (session === current) status('Связь прервана · переподключение…', 'waiting');
  } finally {
    if (session === current) pollTimer = setTimeout(() => poll(current), current.wake ? 0 : connectionLostAt ? 200 : 450);
    current.wake = false;
  }
}
window.addEventListener('online', () => {
  if (!session) return;
  session.epoch++;
  session.wake = true;
  if (pollTimer) poll(session);
});
function reset() {
  endMusic();ui.musicDialog.close();ui.mediaDialog.close();stopGreetings();stopMeter();ui.micDialog.close();ui.largeAvatar.close();ui.historyDialog.close();refreshArchives();
  stopVoiceTest();
  adminMuted = false;
  session = undefined;
  clearTimeout(pollTimer);
  for (const peer of peers.values()) closePeer(peer);
  peers.clear();
  for (const stream of [microphone, display]) stopStream(stream);
  microphone = display = screenOwner = presentationId = watchingId = chatSnapshot = undefined;
  connectionLostAt = undefined;
  showScreen();
  ui.members.replaceChildren();
  ui.messages.replaceChildren();
  ui.message.value = '';
  deafened = false;
  ui.deafen.setAttribute('aria-pressed', 'false');
  ui.deafen.title = 'Отключить звук участников';
  ui.deafen.querySelector('span').textContent = 'Звук';
  ui.inviteDialog.close();
  ui.chatEmpty.hidden = false;
  updateControls();
  ui.room.hidden = true;
  ui.lobby.hidden = false;
}
async function enter(op) {
  const name = ui.name.value.trim();
  if (!name) { ui.name.focus(); notify('Укажи своё имя', true); return; }
  const code = ui.invite.value.trim();
  const internetInvite = code.startsWith('SK1.');
  const invitation = code.match(/^([0-9.]+)\/([a-f0-9]{36})$/);
  if (op === 'join' && !invitation && !internetInvite) { notify('Вставь код приглашения целиком', true); ui.invite.focus(); return; }
  const target = op === 'join' ? (internetInvite ? code : invitation[1]) : undefined;
  await extrasReady;
  const result = await api(op, { name,greeting:personalGreeting, archiveId:op==='create'?ui.archiveSelect.value:undefined,title:op==='create'?ui.archiveTitle.value:undefined,avatar:profilePhoto, target, mode: ui.mode.value, key: invitation?.[2] });
  const { id, host, key, addresses, token } = result;
  session = { volumes:new Map(),generations:new Map(),epoch:0,retries:{},id, host, key, target, token, direct: result.direct, invitation: result.invitation };
  if(op==='join') rememberRoom(code);
  ui.selfName.textContent = name;
  const self = avatar(name);
  ui.selfAvatar.textContent = self.textContent;
  ui.selfAvatar.style.cssText = self.style.cssText; paintAvatar(ui.selfAvatar,profilePhoto);
  ui.lobbyError.hidden = true;
  ui.toast.hidden = true;
  ui.hostNote.querySelector('span').textContent = id === host ? 'Комната работает на твоём ПК' : 'Комната работает на ПК хоста';
  ui.hosting.hidden = op !== 'create' || result.direct;
  ui.networkMessage.hidden = !result.networkMessage;
  ui.networkMessage.textContent = result.networkMessage || '';
  ui.address.replaceChildren(...(addresses?.length ? addresses : ['127.0.0.1']).map(ip => new Option(ip, ip)));
  ui.lobby.hidden = true;
  ui.room.hidden = false;
  updateInvitation();
  updateControls();
  ui.mic.focus();
  poll(session);
}
async function stopScreen(current) {
  const stream = display;
  display = undefined;
  stream?.getTracks().forEach(track => track.stop());
  if (session === current) {
    screenOwner = null;
    showScreen();
    updateControls();
    await Promise.all(Array.from(peers.values(), syncTracks));
    await api('screen', { active: false }, current);
  }
}
const action = fn => async event => {
  event?.preventDefault();
  try { await fn(); } catch (error) {
    const message = error.name === 'NotAllowedError' ? 'Доступ не разрешён. Проверь разрешения микрофона или выбери экран для показа.' : error.name === 'NotFoundError' ? 'Микрофон не найден. Подключи устройство и попробуй снова.' : error.message;
    notify(message, true);
  }
};
let entering = false;
const enterOnce = async op => {
  if (entering || session) return;
  entering = true;
  ui.lanOffer.hidden = true;
  ui.lobbyError.hidden = true;
  ui.create.disabled = ui.joinButton.disabled = true;
  status(op === 'create' && ui.mode.value === 'internet' ? 'Ищем роутер и открываем порт…' : 'Подключаемся…', 'waiting');
  try { await enter(op); } catch (error) {
    const hosting = op === 'create';
    if (hosting ? ui.mode.value === 'internet' : ui.invite.value.trim().startsWith('SK1.')) {
      ui.lanHelp.textContent = 'Подключитесь с друзьями к одной домашней или виртуальной локальной сети. ' +
        (hosting ? 'Затем создай локальную комнату и выбери адрес этой сети в приглашении.' : 'Попроси хоста создать локальную комнату и прислать новый код.');
      ui.lanAction.textContent = hosting ? 'Создать локальную комнату' : 'Ввести локальное приглашение';
      ui.lanOffer.hidden = false;
      ui.lanAction.onclick = action(async () => {
        ui.mode.value = 'lan';
        ui.lanOffer.hidden = ui.lobbyError.hidden = ui.toast.hidden = true;
        if (hosting) await enterOnce('create');
        else { ui.manualJoin.open=true; ui.invite.value = ''; ui.invite.focus(); }
      });
    }
    throw error;
  } finally {
    entering = false;
    ui.create.disabled = ui.joinButton.disabled = false;
    if (!session) status('Готовы к разговору');
  }
};
ui.create.onclick = action(() => enterOnce('create'));
ui.join.onsubmit = action(() => enterOnce('join'));
ui.copy.onclick = action(async () => {
  updateInvitation();
  try {
    await navigator.clipboard.writeText(ui.inviteCode.value);
    ui.copy.querySelector('span').textContent = 'Приглашение скопировано';
  } catch {
    ui.inviteCode.focus();
    ui.inviteCode.select();
    ui.copy.querySelector('span').textContent = 'Нажми Ctrl+C, чтобы скопировать';
  }
});
ui.send.onsubmit = action(async () => {
  const message = ui.message.value.trim();
  if (!message || ui.send.querySelector('button').disabled) return;
  const current = session;
  ui.send.querySelector('button').disabled = true;
  try {
    await api('chat', { message }, current);
    if (session === current && ui.message.value.trim() === message) ui.message.value = '';
  } finally { ui.send.querySelector('button').disabled = false; }
});
const mediaAction = fn => action(async () => {
  if (mediaBusy || !session) return;
  mediaBusy = true;
  updateControls();
  try { await fn(session); } finally { mediaBusy = false; updateControls(); }
});
ui.mic.onclick = mediaAction(async current => {
  if (microphone) {
    stopStream(microphone);
    microphone = undefined;
  } else {
    const stream = await preferredMic();
    if (session !== current || adminMuted) { stopStream(stream); return; }
    microphone = stream;
    watchMic(stream);
  }
  updateControls();
  await Promise.all(Array.from(peers.values(), syncTracks));
});
ui.screen.onclick = mediaAction(async current => {
  if (display) return stopScreen(current);
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: {width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:60,max:60}}, audio: (Boolean(window.roomDevices)||ui.shareAudio.checked) && Boolean(navigator.mediaDevices.getSupportedConstraints().restrictOwnAudio) && {restrictOwnAudio:true,echoCancellation:false,noiseSuppression:false,autoGainControl:false,channelCount:{ideal:2}} });
  stream.getVideoTracks()[0].contentHint = 'motion';
  for (const audio of stream.getAudioTracks()) {
    if (window.roomDevices || audio.getSettings().restrictOwnAudio === true) audio.contentHint = 'music';
    else { stream.removeTrack(audio); audio.stop(); }
  }
  if (ui.shareAudio.checked && !stream.getAudioTracks().length) notify('Захват звука ПК без голосов комнаты недоступен. Демонстрация идёт без системного звука.', true);
  try {
    if (session !== current) return;
    await api('screen', { active:true, screenId:stream.id, hasAudio:stream.getAudioTracks().length > 0 }, current);
    if (session !== current) return;
    display = stream;
    stream.getVideoTracks()[0].onended = () => {
      if (display === stream) stopScreen(current).catch(error => notify(error.message, true));
    };
    presentationId = stream.id;
    screenOwner = current.id;
    showScreen();
    updateControls();
    await Promise.all(Array.from(peers.values(), syncTracks));
  } finally {
    if (display !== stream) stream.getTracks().forEach(track => track.stop());
  }
});
ui.leave.onclick = action(async () => {
  const current = session;
  reset();
  status('Выход из комнаты…');
  await api('leave', {}, current);
  status('Ты вышел из комнаты');
  ui.create.focus();
});
window.addEventListener('pagehide', () => {
  if (session) navigator.sendBeacon('/api', JSON.stringify({ ...session, op: 'leave' }));
});
ui.inviteOpen.onclick = () => {
  updateInvitation();
  ui.copy.querySelector('span').textContent = 'Скопировать приглашение';
  ui.inviteDialog.showModal();
};
ui.inviteClose.onclick = () => ui.inviteDialog.close();
ui.address.onchange = () => {
  updateInvitation();
  ui.copy.querySelector('span').textContent = 'Скопировать приглашение';
};
ui.inviteCode.onclick = () => ui.inviteCode.select();
ui.watchStart.onclick = () => { watchingId = presentationId; showScreen(); };
ui.watchStop.onclick = () => { watchingId = undefined; showScreen(); };
ui.stageShare.onclick = () => ui.screen.click();
ui.deafen.onclick = () => {
  deafened = !deafened;
  for (const peer of peers.values()) {
    peer.audio.muted = deafened;
    if (!deafened) peer.audio.play().catch(() => notify('Нажми «Звук» ещё раз, чтобы разрешить воспроизведение', true));
  }
  showScreen();
  ui.deafen.setAttribute('aria-pressed', deafened);
  ui.deafen.title = deafened ? 'Включить звук участников' : 'Отключить звук участников';
  ui.deafen.querySelector('span').textContent = deafened ? 'Без звука' : 'Звук';
};
ui.fullscreen.onclick = action(() => document.fullscreenElement ? document.exitFullscreen() : ui.stream.requestFullscreen());
async function refreshMicList() {
  await micPreference;
  const devices = await micDevices();
  ui.micList.replaceChildren(new Option('По умолчанию в Windows',''));
  for (const d of devices) {
    if (d.label) ui.micList.add(new Option(d.label,d.deviceId));
  }
  ui.micList.value = devices.find(d => d.label === micLabel)?.deviceId || '';
  if (micLabel && !ui.micList.value) {
    const missing = new Option(micLabel + ' (недоступен)', 'missing', false, true);
    missing.disabled = true;
    ui.micList.add(missing);
  }
  ui.micAccess.hidden = devices.some(d => d.label);
  ui.micHint.textContent = micLabel && !devices.some(d => d.label === micLabel) ? 'Сохранённый микрофон недоступен: ' + micLabel : 'Можно менять устройство во время разговора.';
}
ui.micSettings.onclick = action(async () => { ui.micDialog.showModal(); startMeter(); await refreshMicList(); });
ui.closeMic.onclick = () => ui.micDialog.close();
ui.micAccess.onclick = action(async () => {
  const probe = await captureMic(null,true);
  try {await refreshMicList();} finally {probe.getTracks().forEach(t => t.stop());}
});
ui.micList.onchange = action(async () => {
  stopVoiceTest();
  const chosen = ui.micList.value;
  const label = chosen ? ui.micList.selectedOptions[0].textContent : '';
  const old = microphone;
  ui.micList.disabled = true;
  try {
    if (old) {
      const stream = await captureMic(chosen);
      if (microphone !== old || adminMuted) {stopStream(stream); return;}
      microphone = stream;
      watchMic(stream);
      try { await Promise.all(Array.from(peers.values(),syncTracks)); }
      finally { stopStream(old); }
    }
    micLabel = label;
    await window.roomDevices?.setMic(label);
  } finally {ui.micList.disabled = false; if(ui.micDialog.open)startMeter(); await refreshMicList();}
});
navigator.mediaDevices.addEventListener('devicechange', () => {
  if (ui.micDialog.open && !ui.micList.disabled) refreshMicList().catch(error => notify(error.message,true));
});
window.roomDevices?.onSources(sources => {
  ui.sourceGrid.replaceChildren(...sources.map(source => {
    const button = document.createElement('button');
    button.className = 'source-tile';
    button.title = source.name;
    const preview = source.preview ? document.createElement('img') : document.createElement('span');
    if (source.preview) { preview.src = source.preview; preview.alt = ''; }
    else preview.textContent = 'Миниатюра недоступна';
    const name = document.createElement('span');
    name.textContent = source.name;
    button.append(preview,name);
    button.onclick = () => ui.sourcePicker.close(source.id);
    return button;
  }));
  ui.sourcePicker.returnValue = '';
  ui.sourcePicker.showModal();
});
ui.cancelSource.onclick = () => ui.sourcePicker.close('');
ui.sourcePicker.onclose = () => {
  window.roomDevices?.choose({id:ui.sourcePicker.returnValue || null,audio:ui.shareAudio.checked});
  ui.sourceGrid.replaceChildren();
};

ui.noiseLevel.oninput = () => {
  const level = Number(ui.noiseLevel.value);
  ui.noiseValue.textContent = level + '%';
  const filter = micFilters.get(microphone);
  if (filter) {
    setStrength(filter, level);
    const track = (level ? microphone : filter.input).getAudioTracks()[0];
    for (const peer of peers.values()) {
      if (peer.voice && peer.voice.sender.track !== track) peer.voice.sender.replaceTrack(track).catch(error => notify(error.message,true));
    }
  }
};
if (window.roomDevices?.getGpu) {
  window.roomDevices.getGpu().then(initial => {
    ui.gpuEnabled.checked = initial;
    ui.gpuSettings.hidden = false;
    ui.gpuEnabled.onchange = async () => {
      ui.gpuEnabled.disabled = true;
      try {
        await window.roomDevices.setGpu(ui.gpuEnabled.checked);
        ui.gpuHint.textContent = ui.gpuEnabled.checked === initial ? '' : 'Изменение вступит в силу после перезапуска приложения.';
      } catch { ui.gpuEnabled.checked = !ui.gpuEnabled.checked; notify('Не удалось сохранить настройку GPU',true); }
      finally { ui.gpuEnabled.disabled = false; }
    };
  }).catch(() => {});
}
