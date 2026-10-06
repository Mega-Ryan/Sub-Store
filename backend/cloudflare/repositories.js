import { fail, AppError } from './errors.js';
import { expectedVersion } from './validation.js';
const selects = "SELECT e.*, CASE WHEN e.kind='col' THEN (SELECT json_group_array(name) FROM (SELECT s.name FROM collection_members m JOIN entities s ON s.id=m.subscription_id WHERE m.collection_id=e.id ORDER BY m.position)) ELSE NULL END AS members FROM entities e";
export function decode(row) {
  if (!row) return null;
  const data = JSON.parse(row.data);
  if (row.kind === 'col') data.subscriptions = JSON.parse(row.members ?? '[]');
  return {...data,name:row.name,version:row.version,createdAt:row.created_at,updatedAt:row.updated_at};
}
export async function state(db) { return await db.prepare('SELECT revision,cache_epoch FROM app_state WHERE id=1').first(); }
export async function listRows(db,kind) { return (await db.prepare(selects + ' WHERE e.kind=? ORDER BY e.sort_order,e.id').bind(kind).all()).results; }
export async function list(db,kind) { return (await listRows(db,kind)).map(decode); }
export async function find(db,kind,itemName) {
  const row = await db.prepare(selects + ' WHERE e.kind=? AND e.name=?').bind(kind,itemName).first();
  if (!row) fail('RESOURCE_NOT_FOUND','资源不存在',404);
  return row;
}
export async function mutate(db,statements,{revision,check = '1',args = []} = {}) {
  const head = revision ?? (await state(db)).revision;
  const id = crypto.randomUUID();
  const batch = [
    db.prepare('INSERT INTO mutation_guards(request_id,expected_revision,valid) VALUES(?,?,' + check + ')').bind(id,head,...args),
    db.prepare('UPDATE app_state SET revision=revision+1 WHERE id=1'),
    ...statements,
    db.prepare('DELETE FROM mutation_guards WHERE request_id=?').bind(id),
  ];
  if (batch.length > 45) fail('SIZE_LIMIT','本次操作超出原子写入限制，请减少条目',413);
  try { return await db.batch(batch); } catch(error) {
    if (/VERSION_CONFLICT|CHECK constraint|UNIQUE constraint/.test(String(error))) {
      throw new AppError('VERSION_CONFLICT','数据已变化或名称重复，请刷新后重试',409);
    }
    throw error;
  }
}
function storedData(kind,data) {
  const copy = {...data}; delete copy.name; delete copy.version; delete copy.id;
  if (kind === 'col') delete copy.subscriptions;
  return JSON.stringify(copy);
}
async function memberStatements(db,id,names) {
  const rows = await listRows(db,'sub'); const byName = new Map(rows.map(r => [r.name,r.id]));
  for (const item of names) if (!byName.has(item)) fail('RESOURCE_NOT_FOUND','合集引用的订阅不存在',404,item);
  return [db.prepare('DELETE FROM collection_members WHERE collection_id=?').bind(id),
    ...names.map((item,i) => db.prepare('INSERT INTO collection_members(collection_id,subscription_id,position) VALUES(?,?,?)').bind(id,byName.get(item),i))];
}
export async function create(db,kind,data) {
  const head = await state(db); const id = crypto.randomUUID(); const now = Date.now();
  const statements = [db.prepare('INSERT INTO entities(id,kind,name,data,sort_order,created_at,updated_at) VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM entities WHERE kind=?),0),?,?)').bind(id,kind,data.name,storedData(kind,data),kind,now,now)];
  if (kind === 'col') statements.push(...await memberStatements(db,id,data.subscriptions));
  await mutate(db,statements,{revision:head.revision});
  return decode(await find(db,kind,data.name));
}
export async function update(db,kind,itemName,data,version) {
  expectedVersion(version); const head = await state(db); const row = await find(db,kind,itemName);
  const statements = [db.prepare('UPDATE entities SET name=?,data=?,version=version+1,updated_at=? WHERE id=?').bind(data.name,storedData(kind,data),Date.now(),row.id)];
  if (kind === 'col') statements.push(...await memberStatements(db,row.id,data.subscriptions));
  await mutate(db,statements,{revision:head.revision,check:'(SELECT COUNT(*) FROM entities WHERE id=? AND version=?)',args:[row.id,version]});
  return decode(await find(db,kind,data.name));
}
export async function remove(db,kind,itemName,version) {
  const head = await state(db); const row = await find(db,kind,itemName);
  if (version != null) expectedVersion(version);
  await mutate(db,[db.prepare('DELETE FROM entities WHERE id=?').bind(row.id)],{
    revision:head.revision,check:'(SELECT COUNT(*) FROM entities WHERE id=? AND version=?)',args:[row.id,version ?? row.version],
  });
}
export async function sort(db,kind,orders) {
  const head = await state(db); const rows = await listRows(db,kind);
  if (!Array.isArray(orders) || orders.length !== rows.length || new Set(orders).size !== orders.length || rows.some(r => !orders.includes(r.name))) fail('INVALID_PAYLOAD','排序必须包含当前全部名称各一次');
  await mutate(db,[db.prepare("UPDATE entities SET sort_order=(SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=entities.name) WHERE kind=?").bind(JSON.stringify(orders),kind)],{revision:head.revision});
  return await list(db,kind);
}
export async function getSettings(db) {
  const row = await db.prepare("SELECT data,version FROM settings WHERE key='settings'").first();
  return {...JSON.parse(row.data),_version:row.version};
}
export async function patchSettings(db,data) {
  const version = expectedVersion(data._version,'_version'); const head = await state(db);
  const current = await getSettings(db); const merged = {...current,...data}; delete merged._version;
  await mutate(db,[db.prepare("UPDATE settings SET data=?,version=version+1 WHERE key='settings'").bind(JSON.stringify(merged))],{
    revision:head.revision,check:"(SELECT COUNT(*) FROM settings WHERE key='settings' AND version=?)",args:[version],
  });
  return await getSettings(db);
}
export async function clearCache(db) {
  await mutate(db,[db.prepare('UPDATE app_state SET cache_epoch=cache_epoch+1 WHERE id=1'),db.prepare('DELETE FROM resource_cache')]);
}
export async function appendLog(db,level,code) {
  await db.batch([
    db.prepare('INSERT INTO logs(id,time,level,message) VALUES(?,?,?,?)').bind(crypto.randomUUID(),Date.now(),level,String(code).slice(0,100)),
    db.prepare('DELETE FROM logs WHERE id IN (SELECT id FROM logs ORDER BY time DESC LIMIT -1 OFFSET 1000)'),
  ]);
}

