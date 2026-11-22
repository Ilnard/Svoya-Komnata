const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const root=path.join(process.env.ROOM_DOCUMENTS || path.join(os.homedir(),'Documents'),'Своя комната','Комнаты');
const valid=id=>typeof id==='string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id);
const filename=id=>path.join(root,id,'room.sqlite');
function list(){
  if(!fs.existsSync(root))return [];
  return fs.readdirSync(root).filter(id=>valid(id)&&fs.existsSync(filename(id))).flatMap(id=>{
    const db=new DatabaseSync(filename(id),{readOnly:true});
    try{const row=db.prepare('SELECT json FROM settings WHERE id=1').get();return row?[{id,...JSON.parse(row.json)}]:[];}
    finally{db.close();}
  }).sort((a,b)=>b.opened-a.opened);
}
function open(id,title,mode){
  if(id && (!valid(id)||!fs.existsSync(filename(id))))throw Error('Сохранённая комната не найдена');
  id=id||randomUUID();
  fs.mkdirSync(path.dirname(filename(id)),{recursive:true});
  const db=new DatabaseSync(filename(id));
  try{
    db.exec('CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,bytes BLOB NOT NULL)');
    db.exec('CREATE TABLE IF NOT EXISTS songs(id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS admins(address TEXT PRIMARY KEY)');
    const row=db.prepare('SELECT json FROM settings WHERE id=1').get();
    const settings={...(row?JSON.parse(row.json):{title}),mode,opened:Date.now()};
    db.prepare('INSERT OR REPLACE INTO settings VALUES(1,?)').run(JSON.stringify(settings));
    const page=(before=Number.MAX_SAFE_INTEGER)=>db.prepare('SELECT seq,json FROM messages WHERE seq<? ORDER BY seq DESC LIMIT 100').all(before).reverse().map(r=>({...JSON.parse(r.json),seq:r.seq}));
    let cached;
    const snapshot=()=>{
      const changes=db.prepare('SELECT total_changes() AS n').get().n;
      if(cached?.changes===changes)return cached;
      const file=filename(id);
      const bytes=fs.readFileSync(file);
      cached={changes,size:bytes.length,digest:require('crypto').createHash('sha256').update(bytes).digest('hex'),id};
      return cached;
    };
    return {id,settings,page,snapshot,
      snapshotChunk(digest,offset){
        if(snapshot().digest!==digest)throw Object.assign(Error('Архив изменился'),{status:409});
        if(!Number.isSafeInteger(offset)||offset<0||offset>=cached.size)throw Error('Некорректная позиция');
        const fd=fs.openSync(filename(id),'r');
        try{const bytes=Buffer.alloc(Math.min(49152,cached.size-offset));fs.readSync(fd,bytes,0,bytes.length,offset);return bytes.toString('base64');}finally{fs.closeSync(fd);}
      },
hasAdmin:address=>Boolean(address&&db.prepare('SELECT 1 FROM admins WHERE address=?').get(address)),rememberAdmin(address){if(address)db.prepare('INSERT OR IGNORE INTO admins VALUES(?)').run(address);},
      deleteMessage(id){
        const row=db.prepare("SELECT seq,json FROM messages WHERE json_extract(json,'$.id')=?").get(id);
        if(!row)return;
        const item=JSON.parse(row.json);
        db.exec('BEGIN');
        try{db.prepare('DELETE FROM messages WHERE seq=?').run(row.seq);if(item.file)db.prepare('DELETE FROM files WHERE id=?').run(item.file.id);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
      },
      songs:()=>db.prepare('SELECT json FROM songs ORDER BY rowid').all().map(row=>JSON.parse(row.json)),
      saveMusicPolicy(value){const next={...settings,musicAdmins:value};db.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(next));Object.assign(settings,next);},
      addSong(track,bytes){
        db.exec('BEGIN');
        try{db.prepare('INSERT INTO files VALUES(?,?)').run(track.id,bytes);db.prepare('INSERT INTO songs VALUES(?,?)').run(track.id,JSON.stringify(track));db.exec('COMMIT');}
        catch(e){db.exec('ROLLBACK');throw e;}
      },
      removeSong(id){
        db.exec('BEGIN');
        try{db.prepare('DELETE FROM files WHERE id=?').run(id);db.prepare('DELETE FROM songs WHERE id=?').run(id);db.exec('COMMIT');}
        catch(e){db.exec('ROLLBACK');throw e;}
      },close:()=>db.close(),append(message,bytes){
      db.exec('BEGIN');
      try{
        if(bytes)db.prepare('INSERT INTO files VALUES(?,?)').run(message.file.id,bytes);
        const result=db.prepare('INSERT INTO messages(json) VALUES(?)').run(JSON.stringify(message));
        db.exec('COMMIT');message.seq=Number(result.lastInsertRowid);
      }catch(e){db.exec('ROLLBACK');throw e;}
    },chunk(id,part){
      if(!valid(id)||!Number.isSafeInteger(part)||part<0||part>=342)return null;
      const row=db.prepare('SELECT substr(bytes,?,49152) AS chunk FROM files WHERE id=?').get(part*49152+1,id);
      return row?.chunk?.length?Buffer.from(row.chunk).toString('base64'):null;
    }};
  }catch(e){db.close();throw e;}
}
module.exports={list,open};
