const fs=require('node:fs');
const path=require('node:path');
module.exports=function preferences(documents,legacy) {
  const dir=path.join(documents,'Своя комната'), file=path.join(dir,'settings.json');
  function read(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){if(e.code==='ENOENT') return {}; throw e;}}
  let state=read(file);
  if(!fs.existsSync(file)){
    const oldGpu=read(path.join(legacy,'gpu.json'));
    state={gpu:oldGpu!==false,mic:read(path.join(legacy,'microphone.json')).label||''};
  }
  function save(patch){
    const next={...state,...patch};
    fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(file+'.tmp',JSON.stringify(next,null,2),'utf8');
    fs.renameSync(file+'.tmp',file);
    state=next;
  }
  return {get:()=>state,save};
};
