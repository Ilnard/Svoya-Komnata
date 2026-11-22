const prismArt=document.querySelector('.prism-art');
const quietMotion=matchMedia('(prefers-reduced-motion: reduce)');
let prismInput=null,prismMeter=null,prismContext=null,prismSource=null,prismOwnContext=false;
let prismPulse=0,prismAverage=0,prismLast=0;
const prismBins=new Float32Array(1024);
function detachPrism(){
  if(prismSource&&prismMeter)try{prismSource.disconnect(prismMeter);}catch{}
  prismMeter?.disconnect();
  if(prismOwnContext)prismContext?.close().catch(()=>{});
  prismInput=prismMeter=prismContext=prismSource=null;prismOwnContext=false;prismAverage=0;prismPulse=0;
}
function samplePrism(){
  const active=document.documentElement.dataset.theme==='prism'&&!document.hidden&&!quietMotion.matches;
  const musicPeer=session&&peers.get(session.host);
  const input=active&&musicState?.playing?(hostMusic?.source||musicPeer?.songAudio?.srcObject):null;
  if(input!==prismInput){
    detachPrism();
    if(input){
      prismInput=input;prismOwnContext=!hostMusic;
      prismContext=hostMusic?.ctx||new AudioContext();
      prismSource=hostMusic?.source||prismContext.createMediaStreamSource(input);
      prismMeter=prismContext.createAnalyser();prismMeter.fftSize=2048;prismMeter.smoothingTimeConstant=0.35;
      prismSource.connect(prismMeter);
      prismContext.resume().catch(()=>{});
    }
  }
  let bass=0;
  if(prismMeter&&prismContext.state==='running'){
    prismMeter.getFloatFrequencyData(prismBins);
    const binHz=prismContext.sampleRate/prismMeter.fftSize;
    let count=0;
    for(let i=Math.max(1,Math.ceil(35/binHz));i<=Math.floor(180/binHz);i++){bass+=Math.pow(10,prismBins[i]/20);count++;}
    bass=count?bass/count:0;
  }
  const now=performance.now(),dt=Math.min(0.2,(now-prismLast)/1000||0.04);prismLast=now;
  const impact=Math.max(0,bass-prismAverage*1.15);
  prismAverage+=(bass-prismAverage)*(1-Math.exp(-dt/0.4));
  const target=Math.min(1,bass*2.5+impact*14);
  prismPulse=target>prismPulse?target:prismPulse*Math.exp(-dt/0.22);
  if(!active)prismPulse=0;
  prismArt.style.setProperty('--bass-scale',(1+prismPulse*.23).toFixed(3));
  prismArt.style.setProperty('--bass-light',(.58+prismPulse*.38).toFixed(3));
}
setInterval(samplePrism,40);
window.addEventListener('pagehide',detachPrism);
