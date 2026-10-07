import { fail } from './errors.js';
import { object, supported } from './validation.js';
import { randomToken } from './auth.js';
import { validateTarget } from './conversion/index.js';
import * as repo from './repositories.js';
function duration(input) {
  if(typeof input!=='string') fail('INVALID_EXPIRES_IN','有效期必须是带单位的时间');
  const match=input.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y|day|days|month|months|season|seasons|year|years|hour|hours|minute|minutes)$/i);
  if(!match) fail('INVALID_EXPIRES_IN','有效期时间无效');
  const units={ms:1,s:1000,m:60000,h:3600000,d:86400000,w:604800000,y:31536000000,day:86400000,days:86400000,month:2592000000,months:2592000000,season:7776000000,seasons:7776000000,year:31536000000,years:31536000000,hour:3600000,hours:3600000,minute:60000,minutes:60000};
  const value=Number(match[1])*units[match[2].toLowerCase()];
  if(!Number.isSafeInteger(value)||value<=0||value>315360000000) fail('INVALID_EXPIRES_IN','有效期须在 10 年以内');
  return value;
}
export function expiration(options={}) {
  object(options,'options');
  const mode=options.mode || (options.expiresIn?'duration':options.exp?'datetime':undefined);
  if(mode==='count') {
    const count=Number(options.count),usedCount=Number(options.usedCount??0);
    if(!Number.isSafeInteger(count)||count<1||count>100000000||!Number.isSafeInteger(usedCount)||usedCount<0||usedCount>count) fail('INVALID_SHARE_COUNT','分享次数无效');
    return {mode,count,usedCount};
  }
  if(mode==='datetime') {
    const exp=Number(options.exp);
    if(!Number.isSafeInteger(exp)||exp<1000000000000) fail('INVALID_EXPIRATION_DATETIME','有效期须为毫秒时间戳');
    return {mode,exp};
  }
  if(mode==='duration') {
    let expiresIn=options.expiresIn;
    if(!expiresIn&&options.expiresValue&&options.expiresUnit) expiresIn=String(options.expiresValue)+options.expiresUnit;
    const ms=duration(expiresIn);
    return {mode,expiresIn,exp:Date.now()+ms,
      ...(options.expiresValue?{expiresValue:Number(options.expiresValue),expiresUnit:options.expiresUnit}:{}),
    };
  }
  if(mode) fail('INVALID_EXPIRATION_MODE','不支持的有效期模式');
  return {};
}
export function normalizePayload(payload) {
  object(payload,'payload'); supported(payload);
  if(!['sub','col','file'].includes(payload.type)||typeof payload.name!=='string') fail('INVALID_PAYLOAD','分享必须指定 type 和 name');
  if(payload.token) fail('UNSUPPORTED_FEATURE','基础版自动生成分享令牌，暂不支持自定义或复用令牌',422,'payload.token');
  const copy={...payload}; delete copy.token;
  if(copy.target) validateTarget(copy.target);
  for(const field of ['url','content','process','script','source','template','flowUrl']) {
    if(copy[field] && (!(Array.isArray(copy[field]))||copy[field].length)) fail('UNSUPPORTED_FEATURE','分享不能覆盖资源或处理动作',422,field);
  }
  return copy;
}
export function decodeToken(row) {
  return {...JSON.parse(row.data),type:row.type,name:row.name,token:row.token,createdAt:row.created_at,
    ...(row.exp!==null?{exp:row.exp}:{}),...(row.max_count!==null?{count:row.max_count,usedCount:row.used_count}:{})};
}
export async function listTokens(db,type,name) {
  let sql='SELECT t.*,e.name FROM share_tokens t JOIN entities e ON e.id=t.target_id WHERE 1=1'; const args=[];
  if(type) {sql+=' AND t.type=?';args.push(type);}
  if(name) {sql+=' AND e.name=?';args.push(name);}
  return (await db.prepare(sql+' ORDER BY t.sort_order,t.created_at').bind(...args).all()).results.map(decodeToken);
}
export async function createToken(db,payload,options) {
  payload=normalizePayload(payload);const head=await repo.state(db);
  const target=await repo.find(db,payload.type,payload.name); const token=randomToken(); const expires=expiration(options);
  await repo.mutate(db,[db.prepare('INSERT INTO share_tokens(token,target_id,type,data,exp,max_count,used_count,sort_order,created_at) VALUES(?,?,?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM share_tokens),0),?)').bind(
    token,target.id,payload.type,JSON.stringify({...payload,...expires}),expires.exp??null,expires.count??null,expires.usedCount??0,Date.now(),
  )],{revision:head.revision});
  return {token};
}
export async function deleteToken(db,token,type,name) {
  const head=await repo.state(db);
  const target=await repo.find(db,type,name);
  await repo.mutate(db,[db.prepare('DELETE FROM share_tokens WHERE token=? AND target_id=? AND type=?').bind(token,target.id,type)],{
    revision:head.revision,check:'(SELECT COUNT(*) FROM share_tokens WHERE token=? AND target_id=? AND type=?)',args:[token,target.id,type],
  });
}
export async function updateToken(db,token,type,name,payload,options) {
  payload=normalizePayload(payload); const head=await repo.state(db);
  const currentTarget=await repo.find(db,type,name);
  const target=await repo.find(db,payload.type,payload.name);
  const expires=expiration(options);
  const rows=await db.prepare('SELECT * FROM share_tokens WHERE token=? AND target_id=? AND type=?').bind(token,currentTarget.id,type).first();
  if(!rows)fail('RESOURCE_NOT_FOUND','分享不存在',404);
  await repo.mutate(db,[db.prepare('UPDATE share_tokens SET target_id=?,type=?,data=?,exp=?,max_count=? WHERE token=?').bind(
    target.id,payload.type,JSON.stringify({...payload,...expires}),expires.exp??null,expires.count??null,token,
  )],{revision:head.revision,check:'(SELECT COUNT(*) FROM share_tokens WHERE token=? AND target_id=? AND type=? AND used_count=? AND (? IS NULL OR used_count<=?))',args:[token,currentTarget.id,type,rows.used_count,expires.count??null,expires.count??null]});
  return {token};
}
export async function consume(db,token,kind,itemName,target='ClashMeta') {
  if(typeof token!=='string'||!/^[a-zA-Z0-9_-]{21,128}$/.test(token)) fail('INVALID_TOKEN','分享不存在、已失效或次数已用完',403);
  const row=await db.prepare("UPDATE share_tokens SET used_count=CASE WHEN max_count IS NULL THEN used_count ELSE used_count+1 END WHERE token=? AND type=? AND target_id=(SELECT id FROM entities WHERE kind=? AND name=?) AND (type='file' OR COALESCE(json_extract(data,'$.target'),'') IN ('',?)) AND (exp IS NULL OR exp>?) AND (max_count IS NULL OR used_count<max_count) RETURNING *").bind(token,kind,kind,itemName,target,Date.now()).first();
  if(!row) fail('INVALID_TOKEN','分享不存在、已失效或次数已用完',403);
  return JSON.parse(row.data);
}
export async function sortTokens(db,orders) {
  const head=await repo.state(db);const tokens=await listTokens(db);
  const keys=tokens.map(t=>t.type+'-'+t.name+'-'+t.token);
  if(!Array.isArray(orders)||new Set(orders).size!==keys.length||orders.length!==keys.length||keys.some(k=>!orders.includes(k))) fail('INVALID_PAYLOAD','排序必须包含当前全部分享各一次');
  await repo.mutate(db,[db.prepare("UPDATE share_tokens SET sort_order=(SELECT CAST(j.key AS INTEGER) FROM json_each(?) j JOIN entities e ON e.id=share_tokens.target_id WHERE j.value=share_tokens.type||'-'||e.name||'-'||share_tokens.token)").bind(JSON.stringify(orders))],{revision:head.revision});
  return await listTokens(db);
}

