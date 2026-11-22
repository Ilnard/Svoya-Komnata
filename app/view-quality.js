const heights = [480,720];
const rates = [1,2,4,6,8];
let previewGate;

// A view request is scoped to one presentation and one peer connection.
async function applyViewRequest(peer, from, request, current) {
  const sender=peer.screen?.sender;
  if (!sender?.track || !display || display.id!==request.screen || peer.watching!==request.screen ||
      !heights.includes(request.height) || !rates.includes(request.rate) ||
      typeof request.token!=='string' || request.token.length>64) return;
  const settings=sender.track.getSettings();
  const sourceHeight=settings.height || ui.video.videoHeight;
  if (!sourceHeight) return;
  const scale=Math.max(1,sourceHeight/request.height);
  const params=sender.getParameters();
  if (!params.encodings?.length) return;
  const encoding=params.encodings[0];
  if (encoding.maxBitrate!==request.rate*1000000 || (encoding.scaleResolutionDownBy||1)!==scale) {
    encoding.maxBitrate=request.rate*1000000;
    encoding.scaleResolutionDownBy=scale;
    encoding.maxFramerate=60;
    params.degradationPreference='maintain-framerate';
    await sender.setParameters(params);
  }
  const stats=await sender.getStats();
  const reports=[...stats.values()];
  const source=reports.find(s=>s.type==='media-source' && s.kind==='video');
  const out=reports.find(s=>s.type==='outbound-rtp' && s.kind==='video');
  const limited=out?.qualityLimitationReason==='bandwidth' && out.targetBitrate>0 &&
    out.targetBitrate < encoding.maxBitrate*0.8;
  await signal(from,{viewAck:{token:request.token,sourceHeight,fps:source?.framesPerSecond,
    sourceFrames:source?.frames,limited}},current);
}
function beginView(peer,ready=false) {
  previewGate={peer,id:presentationId,token:crypto.randomUUID(),height:Number(ui.viewHeight.value),
    rate:Number(ui.viewRate.value),start:performance.now(),sent:-Infinity,ready};
  return previewGate;
}
function viewReady(watching,peer) {
  ui.viewSettings.hidden=!watching;
  ui.loadingScreen.hidden=!watching;
  if(!watching){previewGate=undefined;return true;}
  const gate=previewGate && previewGate.peer===peer && previewGate.id===presentationId ? previewGate : beginView(peer,previewGate?.id===presentationId && previewGate.ready);
  if(peer && (!gate.ack || !gate.ready)){
    const now=performance.now();
    if(now-gate.sent>1200){
      gate.sent=now;
      signal(screenOwner,{viewRequest:{screen:gate.id,token:gate.token,height:gate.height,rate:gate.rate}},session).catch(()=>{});
    }
    const receiver=peer.screen?.receiver;
    if(!gate.ready && receiver && gate.ack && !gate.sampling){
      gate.sampling=true;
      receiver.getStats().then(stats=>{
        if(previewGate!==gate || gate.ready)return;
        const video=[...stats.values()].find(s=>s.type==='inbound-rtp' && s.kind==='video');
        if(!video)return;
        const decoded=video.framesDecoded||0;
        const displayed=ui.video.videoHeight;
        gate.firstDecoded??=decoded;
        const matches=displayed>=gate.height && displayed<=gate.height+2 && video.frameHeight===displayed;
        // A still desktop can encode well below 30 fps even on a fast link.
        const inputFps=gate.ack.fps;
        const fpsOK=Number.isFinite(inputFps) ? (video.framesPerSecond||0)>=Math.min(30,inputFps*0.8) : decoded>gate.firstDecoded;
        const still=gate.still && decoded>0 && ui.video.srcObject===peer.presentation;
        if(!matches || (!still && (!fpsOK || gate.ack.limited))){gate.stableSince=undefined;return;}
        gate.stableSince??=performance.now();
        if((decoded>gate.firstDecoded || still) && performance.now()-gate.stableSince>=350 && ui.video.readyState>=2){
          gate.ready=true;showScreen();
        }
      }).catch(()=>{}).finally(()=>{gate.sampling=false;});
    }
  }
  ui.loadingScreen.hidden=gate.ready;
  ui.showAvailable.hidden=performance.now()-gate.start<6500;
  const small=gate.ack?.sourceHeight<gate.height;
  ui.loadingText.textContent=small ? 'Высота источника — '+gate.ack.sourceHeight+' пикс. Выбери меньшее разрешение или открой исходную картинку.' :
    (!ui.showAvailable.hidden ? 'Выбранное качество пока недоступно. Можно подождать или изменить настройки.' : 'Подготовка демонстрации · '+gate.height+'p');
  return gate.ready;
}
function acceptViewAck(peer,ack){
  const gate=previewGate;
  if(gate && gate.peer===peer && gate.token===ack?.token){
    gate.still=Number.isFinite(ack.sourceFrames) && ack.sourceFrames>0 && ack.sourceFrames===gate.ack?.sourceFrames;
    gate.ack=ack;
  }
}
ui.showAvailable.onclick=()=>{if(previewGate){previewGate.ready=true;showScreen();}};
for(const select of [ui.viewHeight,ui.viewRate])select.onchange=()=>{
  if(previewGate)beginView(previewGate.peer,previewGate.ready);
  showScreen();
  savePreference({viewHeight:Number(ui.viewHeight.value),viewRate:Number(ui.viewRate.value)});
};
window.roomDevices?.prefs().then(p=>{
  if(heights.includes(p.viewHeight))ui.viewHeight.value=p.viewHeight;
  if(rates.includes(p.viewRate))ui.viewRate.value=p.viewRate;
}).catch(()=>{});
