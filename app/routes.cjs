const http=require('node:http');
const https=require('node:https');
const tls=require('node:tls');
const net=require('node:net');
const os=require('node:os');

const preferred=new Map();
const number=ip=>ip.split('.').reduce((n,v)=>(n<<8)|Number(v),0);
function sources(host,port,secure){
  if(!net.isIPv4(host)||host.startsWith('127.'))return [undefined];
  const ips=Object.values(os.networkInterfaces()).flat().filter(n=>n.family==='IPv4'&&!n.internal);
  const same=n=>(number(n.address)&number(n.netmask))===(number(host)&number(n.netmask));
  const local=ips.filter(same).map(n=>n.address);
  const others=secure?ips.filter(n=>!same(n)).map(n=>n.address):[];
  const key=host+':'+port,remembered=preferred.get(key);
  const choices=[undefined,...local,...others];
  return [...new Set([...(remembered&&choices.includes(remembered)?[remembered]:[]),...choices])];
}
// Race connection establishment only. Exactly one socket receives the room command.
function dial(options,secure,done){
  const host=options.hostname||options.host,port=options.port,key=host+':'+port;
  const routes=sources(host,port,secure),sockets=new Set();
  let pending=routes.length,finished=false,lastError;
  const timers=[];
  function finish(error,socket){
    if(finished)return;
    finished=true;
    for(const timer of timers)clearTimeout(timer);
    for(const other of sockets)if(other!==socket)other.destroy();
    done(error,socket);
  }
  function attempt(localAddress){
    if(finished)return;
    const opts={host,port,family:4,localAddress};
    let socket;
    function failed(err){lastError=err;if(!--pending)finish(lastError);}
    try{
      socket=secure?tls.connect({...opts,ca:options.ca,checkServerIdentity:options.checkServerIdentity,minVersion:options.minVersion,rejectUnauthorized:true}):net.connect(opts);
    }catch(err){failed(err);return;}
    sockets.add(socket);
    socket.once('error',failed);
    socket.once(secure?'secureConnect':'connect',()=>{
      if(finished)return;
      if(localAddress){if(preferred.size>=32)preferred.clear();preferred.set(key,localAddress);}
      else preferred.delete(key);
      socket.removeListener('error',failed);
      finish(null,socket);
    });
  }
  timers.push(setTimeout(()=>finish(lastError||Error('Хост недоступен через доступные сетевые интерфейсы')),1700));
  routes.forEach((source,i)=>{if(i===0)attempt(source);else timers.push(setTimeout(()=>attempt(source),250));});
}
const lan=new http.Agent({keepAlive:true}),internet=new https.Agent({keepAlive:true,checkServerIdentity:()=>undefined});
lan.createConnection=(opts,done)=>{dial(opts,false,done);};
internet.createConnection=(opts,done)=>{dial(opts,true,done);};
function reset(){
  preferred.clear();
  for(const agent of [lan,internet])for(const list of Object.values(agent.freeSockets))for(const socket of [...list])socket.destroy();
}
module.exports={lan,internet,reset};
