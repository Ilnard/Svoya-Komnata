const heights = [144,240,360,480,720,1080];
const rates = [1,2,4,6,8];
let activeRequest;

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
function updateViewRequest(watching, peer) {
  ui.viewSettings.hidden = !watching;
  if (!watching || !peer) { activeRequest = undefined; return; }
  const height = Number(ui.viewHeight.value), rate = Number(ui.viewRate.value);
  if (!activeRequest || activeRequest.peer !== peer || activeRequest.screen !== presentationId ||
      activeRequest.height !== height || activeRequest.rate !== rate) {
    activeRequest = {peer, screen:presentationId, height, rate, token:crypto.randomUUID(), sent:-Infinity};
  }
  const request = activeRequest;
  if (request.acked || performance.now() - request.sent < 1200) return;
  request.sent = performance.now();
  const {screen, token} = request;
  signal(screenOwner, {viewRequest:{screen, token, height, rate}}, session).catch(()=>{});
}
function acceptViewAck(peer, ack) {
  if (activeRequest && activeRequest.peer === peer && activeRequest.token === ack?.token) activeRequest.acked = true;
}
for(const select of [ui.viewHeight,ui.viewRate])select.onchange=()=>{
  showScreen();
  savePreference({viewHeight:Number(ui.viewHeight.value),viewRate:Number(ui.viewRate.value)});
};
window.roomDevices?.prefs().then(p=>{
  if(heights.includes(p.viewHeight))ui.viewHeight.value=p.viewHeight;
  if(rates.includes(p.viewRate))ui.viewRate.value=p.viewRate;
}).catch(()=>{});
