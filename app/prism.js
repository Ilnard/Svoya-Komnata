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
const throneArt=document.querySelector('.throne-art');
const spirits=[...throneArt.querySelectorAll('i')];
const throneScene=throneArt.querySelector('.throne-scene');
let shake;
let orbitTime=0,torchHeat=0,beatArmed=true;
function animateThrone(dt,pulse,onset=0){
  if(onset<.10)beatArmed=true;
  torchHeat*=Math.exp(-dt/.23);
  if(beatArmed && onset>.29){
    torchHeat=Math.min(1,.45+onset);
    beatArmed=false;
    shake?.cancel();
    const distance=11*torchHeat;
    shake=throneScene.animate([[.55,-.3],[1,-.65],[-.72,.5],[.4,-.35],[-.15,.12],[0,0]]
      .map(([x,y])=>({translate:(x*distance)+'px '+(y*distance)+'px'})),
      {duration:220,easing:'ease-out'});
  }
  throneArt.style.setProperty('--flame',torchHeat.toFixed(3));
  orbitTime+=dt*(1+5*pulse+7*torchHeat);
  throneArt.style.setProperty('--moonlight',(.025+.21*pulse).toFixed(3));
  spirits.forEach((spirit,index)=>{
    const phase=orbitTime*(.29+index*.04)+index*1.9;
    const x=Math.cos(phase)*58+12*Math.sin(phase*1.7),y=Math.sin(phase)*36;
    spirit.style.transform='translate('+x.toFixed(2)+'px,'+y.toFixed(2)+'px) rotate('+ (14*Math.sin(phase*.8)).toFixed(2)+'deg)';
  });
}
function samplePrism(){
  const theme=document.documentElement.dataset.theme;
  const active=(theme==='prism'||theme==='throne')&&!document.hidden&&!quietMotion.matches;
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
  if(theme==='throne'){if(active)animateThrone(dt,prismPulse,Math.min(1,impact/Math.max(.008,prismAverage)));else {shake?.cancel();torchHeat=0;beatArmed=true;throneArt.style.removeProperty('--flame');}return;}
  prismArt.style.setProperty('--bass-scale',(1+prismPulse*.23).toFixed(3));
  prismArt.style.setProperty('--bass-light',(.58+prismPulse*.38).toFixed(3));
}
setInterval(samplePrism,40);
window.addEventListener('pagehide',detachPrism);
/* Morph each ribbon independently. Matching cubic segments let Chromium
   interpolate contours without rebuilding the blurred layers in JavaScript. */
const ribbonTemplate = document.querySelector('#light-ribbon');
const ribbonCurves = [...prismArt.querySelectorAll('.prism-orbit i')].map((layer, index) => {
  const clip = ribbonTemplate.cloneNode(true);
  clip.id = 'prism-curve-' + index;
  ribbonTemplate.parentNode.append(clip);
  layer.style.clipPath = 'url(#' + clip.id + ')';
  return { path: clip.firstElementChild, animation: null };
});

function randomRibbonPath() {
  const bend = .08 + Math.random() * .48;
  const waist = .30 + Math.random() * .36;
  const width = .13 + Math.random() * .21;
  const top = .46 + Math.random() * .49;
  const tip = .50 + Math.random() * .47;
  return 'M ' + top + ' 0 C .70 .16 ' + bend + ' .24 ' + bend + ' ' + waist +
    ' C ' + bend + ' .77 ' + tip + ' .76 ' + tip + ' 1' +
    ' C .58 .82 ' + (bend-width) + ' .86 ' + (bend-width) + ' ' + waist +
    ' C ' + (bend-width) + ' .28 .35 .12 ' + top + ' 0 Z';
}

function animateRibbon(curve) {
  const next = randomRibbonPath();
  curve.animation = curve.path.animate(
    [curve.path.getAttribute('d'), next].map(d => ({ d: 'path("' + d + '")' })),
    { duration: 6500 + Math.random() * 8000, easing: 'ease-in-out' }
  );
  curve.animation.onfinish = () => {
    curve.path.setAttribute('d', next);
    curve.animation = null;
    updateRibbonMotion();
  };
}

function updateRibbonMotion() {
  const active = document.documentElement.dataset.theme === 'prism' && !document.hidden && !quietMotion.matches;
  for (const curve of ribbonCurves) {
    if (!active) curve.animation?.pause();
    else if (!curve.animation) animateRibbon(curve);
    else if (curve.animation.playState === 'paused') curve.animation.play();
  }
}
new MutationObserver(updateRibbonMotion).observe(document.documentElement, {attributes:true, attributeFilter:['data-theme']});
document.addEventListener('visibilitychange', updateRibbonMotion);
quietMotion.addEventListener('change', updateRibbonMotion);
updateRibbonMotion();
