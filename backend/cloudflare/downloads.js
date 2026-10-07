import { AppError, fail } from './errors.js';
import { hash } from './auth.js';
import { byteLength, readText, sourceURL, entity } from './validation.js';
import * as repo from './repositories.js';
import { convert, validateTarget } from './conversion/index.js';
const CROSS_ORIGIN_SAFE_HEADERS = new Set(['user-agent','accept','accept-language']);

export class DownloadContext {
  constructor(env,ctx,options={}) { this.env=env; this.ctx=ctx; this.noCache=options.noCache===true; this.active=0; this.waiters=[]; this.requests=0; this.bytes=0; this.sourceCount=0; this.epoch=null; this.cleaned=false; this.settingsPromise=null; }
  async slot(task) {
    if (this.active>=3) await new Promise(resolve => this.waiters.push(resolve));
    else this.active++;
    try { return await task(); } finally { const next=this.waiters.shift(); if(next) next(); else this.active--; }
  }
  async download(raw,options={}) {
    if (++this.sourceCount>12) fail('SIZE_LIMIT','单次预览或导出最多 12 个远程来源',413);
    const parsed=sourceURL(raw); const args=parsed.args;
    const headers=new Headers();
    const supplied=options.headers ?? args.headers ?? {};
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) fail('INVALID_PAYLOAD','请求头必须是对象');
    for (const [key,value] of Object.entries(supplied)) {
      if (/^(host|cookie|cf-|connection|content-length|origin)/i.test(key)) fail('UNSUPPORTED_FEATURE','不支持的上游请求头',422);
      if (typeof value !== 'string' || value.length>2048) fail('INVALID_PAYLOAD','请求头无效');
      headers.set(key,value);
    }
    const defaults=await (this.settingsPromise??=repo.getSettings(this.env.DB));
    headers.set('User-Agent',options.ua || args.ua || args.userAgent || (options.flow?defaults.defaultFlowUserAgent:defaults.defaultUserAgent) || 'Sub-Store-Cloudflare/1.0');
    this.epoch ??= (await repo.state(this.env.DB)).cache_epoch;
    const key=await hash(JSON.stringify([this.epoch,parsed.url,Array.from(headers)]));
    const noCache=this.noCache || options.noCache===true || args.noCache===true || args.noCache==='true';
    if(!noCache) {
      const cached=await this.env.DB.prepare('SELECT body,flow FROM resource_cache WHERE key=? AND epoch=? AND expires_at>?').bind(key,this.epoch,Date.now()).first();
      if(cached) { this.addBytes(cached.body); return {content:cached.body,flow:cached.flow}; }
    }
    const result=await this.slot(async()=>{
      let url=parsed.url; const controller=new AbortController(); const timeout=Math.max(1000,Math.min(30000,Number(defaults.defaultTimeout)||15000)); const timer=setTimeout(()=>controller.abort(),timeout);
      try {
        for(let redirects=0;redirects<=3;redirects++) {
          if(++this.requests>24) fail('SIZE_LIMIT','上游请求次数超出限制',413);
          const response=await fetch(url,{headers,signal:controller.signal,redirect:'manual'});
          if([301,302,303,307,308].includes(response.status)) {
            await response.body?.cancel();
            if(redirects===3) fail('UPSTREAM_REDIRECT_LIMIT','上游重定向次数过多',502);
            const location=response.headers.get('location'); if(!location) fail('UPSTREAM_INVALID_RESPONSE','上游重定向缺少地址',502);
            const next=sourceURL(new URL(location,url).toString()).url;
            if(new URL(next).origin!==new URL(url).origin) {
              // Custom subscription credentials must stay scoped to the original origin.
              for(const key of Array.from(headers.keys())) {
                if(!CROSS_ORIGIN_SAFE_HEADERS.has(key.toLowerCase())) headers.delete(key);
              }
            }
            url=next; continue;
          }
          if(!response.ok) { await response.body?.cancel(); fail('UPSTREAM_HTTP_ERROR','上游返回 HTTP ' + response.status,502); }
          const declared=Number(response.headers.get('content-length'));
          if(declared>2*1024*1024) { await response.body?.cancel(); fail('SIZE_LIMIT','单个上游响应最多 2 MiB',413); }
          const content=await readText(response.body,2*1024*1024);
          return {content,flow:response.headers.get('subscription-userinfo')};
        }
        fail('UPSTREAM_INVALID_RESPONSE','上游没有返回可用内容',502);
      } catch(error) {
        if(error instanceof AppError) throw error;
        fail(controller.signal.aborted?'UPSTREAM_TIMEOUT':'UPSTREAM_FETCH_FAILED',controller.signal.aborted?'上游请求超时':'获取上游来源失败',502);
      } finally { clearTimeout(timer); }
    });
    this.addBytes(result.content);
    if(!noCache && byteLength(result.content)<=512*1024) {
      const ttl=Math.max(30,Math.min(86400,Number(args.cacheTtl)||Number(this.env.RESOURCE_CACHE_TTL_SECONDS)||300));
      const cacheStatements=[
        this.env.DB.prepare('INSERT INTO resource_cache(key,epoch,body,flow,expires_at,created_at) SELECT ?,?,?,?,?,? WHERE (SELECT cache_epoch FROM app_state WHERE id=1)=? ON CONFLICT(key) DO UPDATE SET body=excluded.body,flow=excluded.flow,expires_at=excluded.expires_at').bind(key,this.epoch,result.content,result.flow,Date.now()+ttl*1000,Date.now(),this.epoch),
      ];
      if(!this.cleaned) {
        this.cleaned=true;
        cacheStatements.push(
          this.env.DB.prepare('DELETE FROM resource_cache WHERE expires_at<=? OR epoch!=(SELECT cache_epoch FROM app_state WHERE id=1)').bind(Date.now()),
          this.env.DB.prepare('DELETE FROM resource_cache WHERE key IN (SELECT key FROM resource_cache ORDER BY created_at DESC LIMIT -1 OFFSET 200)'),
        );
      }
      const cacheTask=this.env.DB.batch(cacheStatements).catch(()=>undefined);
      if(this.ctx) this.ctx.waitUntil(cacheTask); else await cacheTask;
    }
    return result;
  }
  addBytes(text) { this.bytes+=byteLength(text); if(this.bytes>2*1024*1024) fail('SIZE_LIMIT','首版单次转换总输入最多 2 MiB',413); }
}
export async function sourcesForSub(sub,context) {
  sub=entity('sub',sub,{preview:true});
  const local=sub.content??''; let remote=[];
  if(sub.source==='remote' || sub.mergeSources) {
    remote=await Promise.all((sub.url??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(url=>context.download(url,{ua:sub.ua,noCache:sub.noCache,headers:sub.headers})));
  }
  let sources;
  if(sub.source==='local'&&!sub.mergeSources) sources=[{content:local}];
  else sources=sub.mergeSources==='localFirst'?[{content:local},...remote]:sub.mergeSources==='remoteFirst'?[...remote,{content:local}]:remote;
  // Each subscription's actions apply to its combined source, as in upstream.
  return {
    content:sources.map(s=>s.content).join('\n'),processors:sub.process,name:sub.name,
    displayName:sub.displayName,description:sub.description,flow:sub.subUserinfo&&!/^https?:/.test(sub.subUserinfo)?sub.subUserinfo:sources.find(s=>s.flow)?.flow,
  };
}
export async function conversion(kind,data,target,env,ctx,options={}) {
  validateTarget(target); data=entity(kind,data,{preview:true});
  const context=new DownloadContext(env,ctx,options); let sources;
  if(kind==='sub') sources=[await sourcesForSub(data,context)];
  else {
    const rows=await repo.list(env.DB,'sub'); const byName=new Map(rows.map(row=>[row.name,row]));
    sources=[];
    for(const item of data.subscriptions) {
      const sub=byName.get(item); if(!sub) fail('RESOURCE_NOT_FOUND','合集引用的订阅不存在',404,item);
      sources.push(await sourcesForSub(sub,context));
    }
  }
  const result=await convert(sources,target,kind==='col'?data.process:[]);
  return {...result,flow:sources.find(s=>s.flow)?.flow};
}
export async function fileContent(data,env,ctx,options={}) {
  data=entity('file',data,{preview:true});
  if(data.source==='local'&&!data.mergeSources) return {content:data.content??'',flow:data.subUserinfo??null};
  const context=new DownloadContext(env,ctx,options);
  const values=await Promise.all((data.url??'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).map(url=>context.download(url,{ua:data.ua,noCache:data.noCache,headers:data.headers})));
  const content=values.map(item=>item.content).join('\n');
  return {content:data.mergeSources==='localFirst'?(data.content??'')+'\n'+content:data.mergeSources==='remoteFirst'?content+'\n'+(data.content??''):content,flow:values.find(v=>v.flow)?.flow};
}
export function flowInfo(value) {
  if(!value) fail('NO_FLOW_INFO','上游未提供流量信息',404);
  const field=(key,required=false)=>{const match=value.match(new RegExp('(?:^|;|\\s)'+key+'=([-+0-9.eE]+)')); const number=match?Number(match[1]):undefined; if(required&&!Number.isFinite(number)) fail('NO_FLOW_INFO','上游流量信息不完整',404); return number;};
  return {usage:{upload:field('upload')??0,download:field('download',true)},total:field('total',true),expires:field('expire'),remainingDays:field('reset_day')};
}
export function downloadResponse(content,target,itemName,flow) {
  const yaml=/clash|mihomo|stash/i.test(target);
  const structured=/json|sing.?box|v2ray|egern/i.test(target);
  const headers={
    'Content-Type':yaml?'text/yaml; charset=utf-8':structured?'application/json; charset=utf-8':'text/plain; charset=utf-8',
    'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(itemName+(yaml?'.yaml':structured?'.json':'.txt')),
    'Cache-Control':'private, no-store', 'X-Content-Type-Options':'nosniff',
  };
  if(flow&&!/[\r\n]/.test(flow)) headers['subscription-userinfo']=flow;
  return new Response(typeof content==='string'?content:JSON.stringify(content),{headers});
}

