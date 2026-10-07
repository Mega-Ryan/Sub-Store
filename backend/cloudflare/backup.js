import { Base64 } from 'js-base64';
import { fail } from './errors.js';
import { byteLength,entity,object,supported,settings } from './validation.js';
import { expiration,normalizePayload } from './shares.js';
import * as repo from './repositories.js';
export async function exportBackup(db) {
  // A single transactional batch produces a consistent snapshot.
  const results=await db.batch([
    db.prepare('SELECT * FROM entities ORDER BY kind,sort_order,id'),
    db.prepare('SELECT m.collection_id,s.name,m.position FROM collection_members m JOIN entities s ON s.id=m.subscription_id ORDER BY m.position'),
    db.prepare("SELECT data FROM settings WHERE key='settings'"),
    db.prepare('SELECT t.*,e.name FROM share_tokens t JOIN entities e ON e.id=t.target_id ORDER BY t.sort_order,t.created_at'),
  ]);
  const members=new Map();
  for(const row of results[1].results) {if(!members.has(row.collection_id))members.set(row.collection_id,[]);members.get(row.collection_id).push(row.name);}
  const output={schemaVersion:'cloudflare-basic-1',subs:[],collections:[],files:[],settings:JSON.parse(results[2].results[0].data),tokens:[]};
  for(const row of results[0].results) {
    const data={...JSON.parse(row.data),name:row.name};
    if(row.kind==='col')data.subscriptions=members.get(row.id)??[];
    output[row.kind==='sub'?'subs':row.kind==='col'?'collections':'files'].push(data);
  }
  for(const row of results[3].results)output.tokens.push({...JSON.parse(row.data),name:row.name,token:row.token,type:row.type,createdAt:row.created_at,usedCount:row.used_count,...(row.max_count!==null?{count:row.max_count}:{}),...(row.exp!==null?{exp:row.exp}:{})});
  return output;
}
function values(data,key) {
  const value=data[key]??[];
  if(Array.isArray(value))return value;
  if(value&&typeof value==='object')return Object.values(value);
  fail('INVALID_BACKUP_DATA',key+' 必须是数组或对象');
}
export function validateBackup(content) {
  let data=content;
  if(typeof data==='string') {
    try {data=JSON.parse(data);} catch {
      try {data=JSON.parse(Base64.decode(data));} catch {fail('INVALID_BACKUP_DATA','备份必须是 JSON 或 Base64 JSON');}
    }
  }
  object(data); object(data.settings,'settings');
  if(byteLength(JSON.stringify(data))>4*1024*1024)fail('SIZE_LIMIT','备份最多 4 MiB',413);
  for(const key of ['artifacts','modules','archives','rules'])if(values(data,key).length)fail('UNSUPPORTED_FEATURE','备份包含首版不支持的数据：'+key,422,key);
  const result={settings:settings(data.settings),entities:[],tokens:values(data,'tokens')};
  const names=new Map();const ids=new Map();
  for(const [key,kind]of [['subs','sub'],['collections','col'],['files','file']]){
    for(const input of values(data,key)){
      const normalized=entity(kind,input);const ident=kind+':'+normalized.name;
      if(names.has(ident))fail('INVALID_BACKUP_DATA','备份包含重复名称');
      const id=crypto.randomUUID();names.set(ident,normalized);ids.set(ident,id);
      result.entities.push({kind,id,data:normalized});
    }
  }
  for(const item of result.entities)if(item.kind==='col')for(const sub of item.data.subscriptions)if(!names.has('sub:'+sub))fail('INVALID_BACKUP_DATA','合集引用缺失的订阅');
  const tokenSet=new Set();
  result.tokens=result.tokens.map(token=>{
    object(token);supported(token,'tokens');
    if(!['sub','col','file'].includes(token.type)||!ids.has(token.type+':'+token.name)||typeof token.token!=='string'||!/^[a-zA-Z0-9_-]{21,128}$/.test(token.token)||tokenSet.has(token.token))fail('INVALID_BACKUP_DATA','备份中的分享目标或令牌无效');
    tokenSet.add(token.token);
    const {token:rawToken,mode,count,usedCount,exp,expiresIn,expiresValue,expiresUnit,createdAt,targetId,...input}=token;
    const payload=normalizePayload(input);
    // Restoring a saved expiry must never restart a duration, including legacy backups.
    const options=expiration({...token,mode:token.exp&&(!token.mode||token.mode==='duration')?'datetime':token.mode});
    if(options.mode!=='count') {
      const history=usedCount===undefined?0:usedCount;
      if(!Number.isSafeInteger(history)||history<0||history>100000000)fail('INVALID_BACKUP_DATA','分享已用次数无效');
      options.usedCount=history;
    }
    if(createdAt!==undefined&&(!Number.isSafeInteger(createdAt)||createdAt<0))fail('INVALID_BACKUP_DATA','分享创建时间无效');
    return {...payload,...options,token:rawToken,...(createdAt!==undefined?{createdAt}:{}),targetId:ids.get(token.type+':'+token.name)};
  });
  result.ids=ids;return result;
}
export async function importBackup(db,content) {
  const prepared=validateBackup(content);const head=await repo.state(db);const now=Date.now();
  const statements=[
    db.prepare('DELETE FROM share_tokens'),db.prepare('DELETE FROM collection_members'),db.prepare('DELETE FROM entities'),
    db.prepare("UPDATE settings SET data=?,version=version+1 WHERE key='settings'").bind(JSON.stringify(prepared.settings)),
  ];
  // JSON parameters avoid bound-parameter count and statement-length explosions.
  const rows=prepared.entities.map((item,index)=>{
    const stored={...item.data};delete stored.name;delete stored.subscriptions;delete stored.version;
    return {id:item.id,kind:item.kind,name:item.data.name,data:JSON.stringify(stored),position:index};
  });
  function chunks(items,limit=700000){
    const result=[];let current=[],size=2;
    for(const item of items){const bytes=byteLength(JSON.stringify(item))+1;if(bytes>1000000)fail('SIZE_LIMIT','备份条目过大',413);if(current.length&&size+bytes>limit){result.push(current);current=[];size=2;}current.push(item);size+=bytes;}
    if(current.length)result.push(current);return result;
  }
  for(const chunk of chunks(rows))statements.push(db.prepare("INSERT INTO entities(id,kind,name,data,sort_order,created_at,updated_at) SELECT json_extract(value,'$.id'),json_extract(value,'$.kind'),json_extract(value,'$.name'),json_extract(value,'$.data'),json_extract(value,'$.position'),?,? FROM json_each(?)").bind(now,now,JSON.stringify(chunk)));
  const members=prepared.entities.filter(e=>e.kind==='col').flatMap(e=>e.data.subscriptions.map((s,i)=>({collection:e.id,sub:prepared.ids.get('sub:'+s),position:i})));
  for(const chunk of chunks(members))statements.push(db.prepare("INSERT INTO collection_members(collection_id,subscription_id,position) SELECT json_extract(value,'$.collection'),json_extract(value,'$.sub'),json_extract(value,'$.position') FROM json_each(?)").bind(JSON.stringify(chunk)));
  for(const chunk of chunks(prepared.tokens))statements.push(db.prepare("INSERT INTO share_tokens(token,target_id,type,data,exp,max_count,used_count,sort_order,created_at) SELECT json_extract(value,'$.token'),json_extract(value,'$.targetId'),json_extract(value,'$.type'),value,json_extract(value,'$.exp'),json_extract(value,'$.count'),COALESCE(json_extract(value,'$.usedCount'),0),CAST(key AS INTEGER),COALESCE(json_extract(value,'$.createdAt'),?) FROM json_each(?)").bind(now,JSON.stringify(chunk)));
  statements.push(db.prepare('UPDATE app_state SET cache_epoch=cache_epoch+1 WHERE id=1'),db.prepare('DELETE FROM resource_cache'));
  await repo.mutate(db,statements,{revision:head.revision});
}

