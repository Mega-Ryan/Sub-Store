import { timingSafeEqual } from 'node:crypto';
import { fail, json } from './errors.js';
import { readJSON } from './validation.js';
const COOKIE = '__Host-substore_session';
export function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)),v => v.toString(16).padStart(2,'0')).join(''); }
export async function hash(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),v => v.toString(16).padStart(2,'0')).join('');
}
export function checkOrigin(request,env) {
  if (!env.PUBLIC_ORIGIN) fail('CONFIGURATION_ERROR','服务尚未完成配置',503);
  if (request.headers.get('origin') !== env.PUBLIC_ORIGIN) fail('INVALID_ORIGIN','请求来源不允许',403);
}
function cookieToken(request) {
  const cookies = request.headers.get('cookie') ?? '';
  const match = cookies.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  const token = match?.slice(COOKIE.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function session(request,env) {
  const token = cookieToken(request); if (!token) return null;
  const row = await env.DB.prepare('SELECT token_hash,expires_at FROM admin_sessions WHERE token_hash=? AND expires_at>?').bind(await hash(token),Date.now()).first();
  return row;
}
export async function requireSession(request,env) {
  if (!await session(request,env)) fail('UNAUTHORIZED','请先登录管理端',401);
}
export async function login(request,env) {
  checkOrigin(request,env);
  if (!env.ADMIN_LOGIN_TOKEN || env.ADMIN_LOGIN_TOKEN.length < 32) fail('CONFIGURATION_ERROR','管理员凭据尚未配置',503);
  const body = await readJSON(request,4096);
  const ip = await hash(request.headers.get('cf-connecting-ip') ?? 'unknown');
  const window = Math.floor(Date.now()/900000)*900000;
  const attempt = await env.DB.prepare('INSERT INTO login_attempts(ip_hash,window_start,count) VALUES(?,?,1) ON CONFLICT(ip_hash) DO UPDATE SET count=CASE WHEN window_start=excluded.window_start THEN count+1 ELSE 1 END,window_start=excluded.window_start RETURNING count').bind(ip,window).first();
  if (attempt.count > 20) fail('TOO_MANY_ATTEMPTS','登录尝试过多，请稍后重试',429);
  const candidate = typeof body.token === 'string' && body.token.length <= 512 ? body.token : '';
  const left = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(candidate)));
  const right = new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(env.ADMIN_LOGIN_TOKEN)));
  if (!timingSafeEqual(left,right)) fail('INVALID_CREDENTIAL','管理凭据不正确',401);
  const token = randomToken(); const ttl = Math.max(300,Math.min(86400,Number(env.SESSION_TTL_SECONDS)||21600));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').bind(Date.now()),
    env.DB.prepare('DELETE FROM login_attempts WHERE window_start<?').bind(window-900000),
    env.DB.prepare('INSERT INTO admin_sessions(token_hash,expires_at) VALUES(?,?)').bind(await hash(token),Date.now()+ttl*1000),
  ]);
  return json({authenticated:true},200,{'Set-Cookie':COOKIE + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=' + ttl});
}
export async function logout(request,env) {
  checkOrigin(request,env);
  const token = cookieToken(request);
  if (token) await env.DB.prepare('DELETE FROM admin_sessions WHERE token_hash=?').bind(await hash(token)).run();
  return json({authenticated:false},200,{'Set-Cookie':COOKIE + '=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'});
}

