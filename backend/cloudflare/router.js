import { fail,json,errorResponse } from './errors.js';
import { readJSON,entity,name,supported,object,expectedVersion } from './validation.js';
import { login,logout,session,requireSession,checkOrigin } from './auth.js';
import * as repo from './repositories.js';
import * as shares from './shares.js';
import { exportBackup,importBackup } from './backup.js';
import { conversion,fileContent,DownloadContext,flowInfo,downloadResponse } from './downloads.js';
import { SUPPORTED_PROCESSORS,SUPPORTED_TARGETS,validateTarget } from './conversion/index.js';
const types={subs:'sub',collections:'col',files:'file',wholeFiles:'file'};
const singular={sub:'sub',collection:'col',file:'file',wholeFile:'file'};
export const VERSION='2.42.2-cf.1';
function environment(env){
  const feature={share:true,archive:false,sync:false,dynamicScripts:false,backup:true,logs:true};
  const capabilities={processors:[...SUPPORTED_PROCESSORS],targets:[...SUPPORTED_TARGETS],dynamicScripts:false,artifactSync:false,archive:false,customTokens:false,
    files:true,backupImportExport:true,serverProxy:false,resolveDomain:false,mmdb:false,
    limits:{savedContentBytes:524288,conversionInputBytes:2097152,remoteSources:12,backupBytes:4194304}};
  return {backend:'Cloudflare Workers',version:VERSION,feature,capabilities,secretPath:'',revision:env.BUILD_REVISION??'development'};
}
function bool(value){return value==='true'||value==='1';}
async function render(kind,itemName,target,env,ctx,options={}){
  const data=repo.decode(await repo.find(env.DB,kind,itemName));
  if(kind==='file'){const result=await fileContent(data,env,ctx,options);return downloadResponse(result.content,'text',itemName,result.flow);}
  const result=await conversion(kind,data,target,env,ctx,options);
  return downloadResponse(result.output,target,itemName,result.flow);
}
export async function handle(request,env,ctx){
  const url=new URL(request.url); const path=url.pathname; let publicShare=path.startsWith('/share/');
  try {
    if(path==='/health'&&request.method==='GET')return json({backend:'Cloudflare Workers',version:VERSION,revision:env.BUILD_REVISION??'development'});
    if(path==='/api/auth/login'&&request.method==='POST')return await login(request,env);
    if(path==='/api/auth/session'&&request.method==='GET')return json({authenticated:!!await session(request,env)});
    if(path==='/api/auth/logout'&&request.method==='POST')return await logout(request,env);
    if(publicShare){
      if(!['GET','HEAD'].includes(request.method))fail('METHOD_NOT_ALLOWED','只允许 GET',405);
      const parts=path.split('/').slice(2).map(s=>decodeURIComponent(s)); const [kind,itemName,targetPath]=parts;
      if(!['sub','col','file'].includes(kind)||!itemName||parts.length>3)fail('RESOURCE_NOT_FOUND','分享路径不存在',404);
      for(const key of url.searchParams.keys())if(!['token','target','platform'].includes(key))fail('UNSUPPORTED_FEATURE','分享链接不支持参数覆盖',422,key);
      const target=targetPath||url.searchParams.get('target')||url.searchParams.get('platform')||'ClashMeta';
      if(kind!=='file')validateTarget(target);
      await shares.consume(env.DB,url.searchParams.get('token'),kind,itemName,target);
      const response=await render(kind,itemName,target,env,ctx);
      return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
    }
    await requireSession(request,env);
    if(!['GET','HEAD'].includes(request.method))checkOrigin(request,env);
    if(path==='/api/utils/env'&&request.method==='GET')return json(environment(env));
    if(path==='/api/utils/refresh'&&['GET','POST'].includes(request.method)){await repo.clearCache(env.DB);return json({});}
    if(path==='/api/settings'){
      if(request.method==='GET')return json(await repo.getSettings(env.DB));
      if(request.method==='PATCH'){const input=object(await readJSON(request));supported(input,'settings');return json(await repo.patchSettings(env.DB,input));}
    }
    if(path==='/api/storage'){
      if(request.method==='GET')return new Response(JSON.stringify(await exportBackup(env.DB),null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':"attachment; filename*=UTF-8''sub-store-backup.json",'Cache-Control':'no-store'}});
      if(request.method==='POST'){const input=await readJSON(request,6*1024*1024);await importBackup(env.DB,input.content??input);return json({});}
    }
    if(path==='/api/logs'){
      if(request.method==='GET'){
        const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||100));
        const keyword=url.searchParams.get('keyword')??'';
        if(keyword.length>128)fail('SIZE_LIMIT','日志关键词最多 128 个字符',413);
        if(bool(url.searchParams.get('regex')))fail('UNSUPPORTED_FEATURE','基础版日志搜索支持文字关键词',422);
        const ignoreCase=bool(url.searchParams.get('ignoreCase'));
        const rows=(await env.DB.prepare('SELECT * FROM logs ORDER BY time DESC LIMIT 1000').all()).results;
        const needle=ignoreCase?keyword.toLowerCase():keyword;
        const filtered=rows.filter(row=>{const text=row.level+' '+row.message;return (ignoreCase?text.toLowerCase():text).includes(needle);});
        return json({logs:filtered.slice(0,limit),total:filtered.length,maxCount:1000});
      }
      if(request.method==='DELETE'){await env.DB.prepare('DELETE FROM logs').run();return json({});}
    }
    if(path==='/api/token'&&request.method==='POST'){
      const input=await readJSON(request);return json(await shares.createToken(env.DB,input.payload,input.options));
    }
    if(path==='/api/tokens'&&request.method==='GET')return json(await shares.listTokens(env.DB,url.searchParams.get('type'),url.searchParams.get('name')));
    const tokenMatch=path.match(/^\/api\/token\/([^/]+)$/);
    if(tokenMatch&&request.method==='PATCH'){
      const input=await readJSON(request);
      return json(await shares.updateToken(env.DB,decodeURIComponent(tokenMatch[1]),url.searchParams.get('type'),url.searchParams.get('name'),input.payload,input.options));
    }
    if(tokenMatch&&request.method==='DELETE'){
      if(url.searchParams.get('mode')==='archive')fail('UNSUPPORTED_FEATURE','基础版不支持归档',422);
      await shares.deleteToken(env.DB,decodeURIComponent(tokenMatch[1]),url.searchParams.get('type'),url.searchParams.get('name'));return json({});
    }
    const sortMatch=path.match(/^\/api\/sort\/([^/]+)$/);
    if(sortMatch&&request.method==='POST'){
      const input=await readJSON(request);
      if(sortMatch[1]==='tokens')return json(await shares.sortTokens(env.DB,input));
      const kind=types[sortMatch[1]];if(!kind)fail('UNSUPPORTED_FEATURE','基础版不支持该排序对象',422);
      return json(await repo.sort(env.DB,kind,input));
    }
    const previewMatch=path.match(/^\/api\/preview\/(sub|collection|file)$/);
    if(previewMatch&&request.method==='POST'){
      const input=await readJSON(request);const kind=previewMatch[1]==='collection'?'col':previewMatch[1];
      if(kind==='file'){const result=await fileContent(input,env,ctx);return json({original:result.content,processed:result.content});}
      const result=await conversion(kind,input,url.searchParams.get('target')||'JSON',env,ctx);
      return json({original:result.originalProxies,processed:result.proxies,warnings:result.warnings});
    }
    const flowMatch=path.match(/^\/api\/sub\/flow\/([^/]+)$/);
    if(flowMatch&&request.method==='GET'){
      const sub=repo.decode(await repo.find(env.DB,'sub',decodeURIComponent(flowMatch[1])));
      if(sub.noFlow||bool(url.searchParams.get('noFlow')))fail('NO_FLOW_INFO','已关闭流量信息',404);
      let flow=sub.subUserinfo;
      const context=new DownloadContext(env,ctx);
      if(typeof flow==='string'&&/^https?:/.test(flow))flow=(await context.download(flow,{flow:true})).flow;
      if(!flow&&sub.url)flow=(await context.download((url.searchParams.get('url')||sub.url).split(/\r?\n/)[0],{flow:true})).flow;
      return json(flowInfo(flow));
    }
    const listMatch=path.match(/^\/api\/(subs|collections|files|wholeFiles)$/);
    if(listMatch){
      const kind=types[listMatch[1]];
      if(request.method==='GET')return json(await repo.list(env.DB,kind));
      if(request.method==='POST')return json(await repo.create(env.DB,kind,entity(kind,await readJSON(request))),201);
      if(request.method==='PUT')fail('UNSUPPORTED_FEATURE','整份替换请使用已校验的备份导入，排序请使用排序接口',422);
    }
    const itemMatch=path.match(/^\/api\/(sub|collection|file|wholeFile)\/([^/]+)$/);
    if(itemMatch){
      const kind=singular[itemMatch[1]],itemName=decodeURIComponent(itemMatch[2]);
      if(request.method==='GET'){
        const data=repo.decode(await repo.find(env.DB,kind,itemName));
        if(url.searchParams.get('raw'))return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
        return json(data);
      }
      if(request.method==='PATCH'){
        const input=await readJSON(request);const current=repo.decode(await repo.find(env.DB,kind,itemName));
        return json(await repo.update(env.DB,kind,itemName,entity(kind,{...current,...input}),expectedVersion(input.version)));
      }
      if(request.method==='DELETE'){
        if(url.searchParams.get('mode')==='archive')fail('UNSUPPORTED_FEATURE','基础版不支持归档',422);
        await repo.remove(env.DB,kind,itemName,url.searchParams.get('version')?Number(url.searchParams.get('version')):undefined);return json({});
      }
    }
    const downloadParts=path.split('/').filter(Boolean).map(s=>decodeURIComponent(s));
    if(downloadParts[0]==='download'&&['GET','HEAD'].includes(request.method)){
      let kind='sub',itemName,target;
      if(downloadParts[1]==='collection'){kind='col';itemName=downloadParts[2];target=downloadParts[3];}
      else if(downloadParts[1]==='file'){kind='file';itemName=downloadParts[2];}
      else {itemName=downloadParts[1];target=downloadParts[2];}
      for(const key of url.searchParams.keys())if(!['target','platform','noCache'].includes(key))fail('UNSUPPORTED_FEATURE','下载不支持临时配置覆盖',422,key);
      if(!itemName)fail('RESOURCE_NOT_FOUND','下载路径不存在',404);
      const response=await render(kind,itemName,target||url.searchParams.get('target')||url.searchParams.get('platform')||'ClashMeta',env,ctx,{noCache:bool(url.searchParams.get('noCache'))});
      return request.method==='HEAD'?new Response(null,{status:response.status,headers:response.headers}):response;
    }
    if(path.startsWith('/api/artifact')||path.startsWith('/api/archive')||path==='/api/utils/backup'||path.startsWith('/api/sync')||path.startsWith('/api/module'))fail('UNSUPPORTED_FEATURE','Cloudflare 基础版暂不支持此功能',501);
    fail('RESOURCE_NOT_FOUND','API 路径不存在',404);
  } catch(error){
    if(ctx)ctx.waitUntil(repo.appendLog(env.DB,'error',error.code||'INTERNAL_SERVER_ERROR').catch(()=>undefined));
    return errorResponse(error,publicShare);
  }
}

