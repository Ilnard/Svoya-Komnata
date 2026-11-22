const udp = require('node:dgram');
const os = require('node:os');
const {randomBytes} = require('node:crypto');
const {encodeInvite} = require('./direct.cjs');
const port = 47833;
const signature = 'SVROOM/1 ';
const number = ip => ip.split('.').reduce((n,part)=>(n<<8)|Number(part),0)>>>0;
const ip = n => [24,16,8,0].map(shift=>(n>>>shift)&255).join('.');
const interfaces = () => Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4');
function local(address){return interfaces().some(n=>(number(address)&number(n.netmask))===(number(n.address)&number(n.netmask)));}
function advertise(describe){
  const socket=udp.createSocket('udp4');
  socket.on('error',()=>{});
  socket.on('message',(msg,remote)=>{
    if(msg.length!==signature.length+16 || !local(remote.address))return;
    const query=msg.toString();
    if(!query.startsWith(signature) || !/^[a-f0-9]{16}$/.test(query.slice(signature.length)))return;
    const room=describe();
    if(room)socket.send(JSON.stringify({...room,nonce:query.slice(signature.length)}),remote.port,remote.address,()=>{});
  });
  socket.bind(port);
  return socket;
}
function discover(){
  return new Promise(resolve=>{
    const socket=udp.createSocket('udp4'),rooms=new Map();
    const nonce=randomBytes(8).toString('hex');
    const end=()=>{clearTimeout(timer);try{socket.close();}catch{}resolve([...rooms.values()]);};
    const timer=setTimeout(end,450);
    socket.once('error',end);
    socket.on('message',(msg,remote)=>{
      if(msg.length>5000 || rooms.size>=64 || !local(remote.address))return;
      try{
        const r=JSON.parse(msg);
        if(r.nonce!==nonce || !/^[a-f0-9]{36}$/.test(r.key) || typeof r.name!=='string' || !Number.isInteger(r.count) || r.count<1 || r.count>8)return;
        const code=r.endpoint ? encodeInvite({...r.endpoint,address:remote.address,key:r.key}):remote.address+'/'+r.key;
        rooms.set(r.key,{name:r.name.slice(0,32),count:r.count,code,key:r.key});
      }catch{}
    });
    socket.bind(0,()=>{
      socket.setBroadcast(true);
      const targets=new Set(['127.0.0.1']);
      for(const n of interfaces().filter(n=>!n.internal && n.netmask!=='255.255.255.255'))
        targets.add(ip(number(n.address)|~number(n.netmask)));
      for(const address of targets)socket.send(signature+nonce,port,address,()=>{});
    });
  });
}
module.exports={advertise,discover};
