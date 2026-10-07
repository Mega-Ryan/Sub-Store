import { fail } from './errors.js';
import { validateProcessors } from './conversion/index.js';
export const byteLength = value => new TextEncoder().encode(value).byteLength;
export function object(value, path = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_PAYLOAD','需要对象：' + path);
  return value;
}
export function name(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f/?#\\]/.test(value)) {
    fail('INVALID_NAME','名称须为 1–128 个字符，不能包含路径或控制字符');
  }
  return value.trim();
}
const forbiddenKeys = new Set([
  'script','scriptUrl','scriptURL','proxy','insecure','dispatcher',
  'ageSecretKey','agePublicKey','agePassword','age-secret-key','age-public-key','age-password','gistToken','cron','scriptParameters',
  'sourceType','sourceName','module','modules','filePath','mmdb',
]);
export function supported(value, path = 'body', depth = 0) {
  if (depth > 20) fail('INVALID_PAYLOAD','配置嵌套过深');
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__','constructor','prototype'].includes(key)) fail('INVALID_PAYLOAD','不允许的属性：' + path + '.' + key);
    if (forbiddenKeys.has(key) && item !== '' && item !== null && item !== undefined && item !== false &&
      !(Array.isArray(item) && item.length === 0)) {
      fail('UNSUPPORTED_FEATURE','Cloudflare 基础版不支持：' + key,422,path + '.' + key);
    }
    if (key === 'process') validateProcessors(item ?? [],path + '.process');
    else supported(item,path + '.' + key,depth + 1);
  }
}
export function entity(kind, input, { preview = false } = {}) {
  object(input); supported(input);
  const data = structuredClone(input);
  if (!preview || data.name) data.name = name(data.name);
  else data.name = 'preview';
  delete data.version; delete data.id; delete data.createdAt; delete data.updatedAt;
  data.process ??= [];
  validateProcessors(data.process);
  if (kind === 'col') {
    if (!Array.isArray(data.subscriptions) || data.subscriptions.some(v => typeof v !== 'string')) fail('INVALID_PAYLOAD','合集 subscriptions 必须是名称数组');
    data.subscriptions = [...new Set(data.subscriptions.map(name))];
    if (data.subscriptions.length > 32) fail('SIZE_LIMIT','合集最多 32 个订阅',413);
    if (data.subscriptionTags?.length) fail('UNSUPPORTED_FEATURE','首版请通过名称选择合集订阅',422,'subscriptionTags');
  } else {
    data.source ??= data.url ? 'remote' : 'local';
    if (!['local','remote'].includes(data.source)) fail('UNSUPPORTED_FEATURE','只支持本地内容和 HTTP／HTTPS 来源',422,'source');
    if (data.content != null && typeof data.content !== 'string') fail('INVALID_PAYLOAD','content 必须是文本');
    if (byteLength(data.content ?? '') > 512 * 1024) fail('SIZE_LIMIT','保存的单条内容最多 512 KiB',413);
    if (data.url != null && typeof data.url !== 'string') fail('INVALID_PAYLOAD','url 必须是文本');
    const urls = (data.url ?? '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (urls.length > 12) fail('SIZE_LIMIT','单次请求最多 12 个远程来源',413);
    for (const url of urls) sourceURL(url);
    if (data.source === 'remote' && !urls.length) fail('INVALID_PAYLOAD','远程来源不能为空');
    if (kind === 'file') {
      if (data.process.length || (data.type && !['text','plain','file','json','yaml','generic','normal'].includes(data.type))) {
        fail('UNSUPPORTED_FEATURE','首版文件仅支持原文保存和下载，不支持处理动作或配置生成',422);
      }
      data.type = 'text';
    }
  }
  if (data.mergeSources && !['localFirst','remoteFirst'].includes(data.mergeSources)) fail('UNSUPPORTED_FEATURE','不支持的来源合并方式',422);
  if (data.ignoreFailedRemoteSub && !['disabled','off','none'].includes(data.ignoreFailedRemoteSub)) {
    fail('UNSUPPORTED_FEATURE','首版不会忽略失败来源；请关闭忽略远程失败选项',422,'ignoreFailedRemoteSub');
  }
  if (byteLength(JSON.stringify(data)) > 768 * 1024) fail('SIZE_LIMIT','单条配置过大',413);
  return data;
}
export function sourceURL(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { fail('INVALID_URL','来源 URL 无效'); }
  if (!['http:','https:'].includes(parsed.protocol)) fail('UNSUPPORTED_FEATURE','来源必须使用 HTTP／HTTPS',422);
  if (parsed.username || parsed.password) fail('UNSUPPORTED_FEATURE','请使用请求头配置上游认证，不使用 URL 用户名密码',422);
  const host = parsed.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) ||
    host === '::1' || /^(fc|fd|fe[89ab])/i.test(host) && host.includes(':')) {
    fail('UNSUPPORTED_FEATURE','Workers 不能读取本地或私有网络来源',422);
  }
  const args = {};
  if (parsed.hash) {
    const hash = parsed.hash.slice(1);
    let values;
    try {
      const decoded = decodeURIComponent(hash);
      values = decoded.startsWith('{') ? JSON.parse(decoded) : Object.fromEntries(new URLSearchParams(hash));
    } catch { fail('INVALID_URL','来源 URL 参数无效'); }
    object(values,'url#arguments');
    for (const [key,value] of Object.entries(values)) {
      if (!['ua','userAgent','headers','noCache','noFlow','cacheTtl'].includes(key)) fail('UNSUPPORTED_FEATURE','不支持的来源参数：' + key,422);
      args[key] = value;
    }
  }
  parsed.hash = '';
  return { url: parsed.toString(), args };
}
export function expectedVersion(value, field = 'version') {
  if (!Number.isSafeInteger(value) || value < 1) fail('VERSION_CONFLICT','请重新读取最新数据后再保存',409,field);
  return value;
}
export function settings(input) {
  object(input,'settings');supported(input,'settings');const data=structuredClone(input);
  for(const key of ['defaultUserAgent','defaultFlowUserAgent']){
    if(data[key]!==undefined&&(typeof data[key]!=='string'||data[key].length>2048||/[\r\n]/.test(data[key])))fail('INVALID_PAYLOAD','User-Agent 必须是有效文本',400,key);
  }
  if(data.defaultTimeout!==undefined){
    const timeout=Number(data.defaultTimeout);
    if(!Number.isSafeInteger(timeout)||timeout<1000||timeout>30000)fail('INVALID_PAYLOAD','请求超时须为 1000–30000 毫秒',400,'defaultTimeout');
    data.defaultTimeout=timeout;
  }
  return data;
}
export async function readJSON(request, limit = 4 * 1024 * 1024) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) fail('INVALID_CONTENT_TYPE','请使用 application/json',415);
  const text = await readText(request.body, limit);
  try { return JSON.parse(text); } catch { fail('INVALID_JSON','请求 JSON 无效'); }
}
export async function readText(stream, limit) {
  if (!stream) return '';
  const reader = stream.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const {value,done} = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); fail('SIZE_LIMIT','输入内容超过大小限制',413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const joined = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { joined.set(chunk,offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(joined);
}

