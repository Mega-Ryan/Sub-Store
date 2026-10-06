import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime } from './runtime-helper.mjs';

const worker = 'import worker from "./worker.ts"; export default worker;';
const origin = 'https://test.example';
const ss = 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:8388#Hong%20Kong';
const subscription = (name) => ({ name, source: 'local', content: ss, process: [] });

async function request(instance, path, { method = 'GET', cookie, body, headers = {} } = {}) {
    const response = await instance.mf.dispatchFetch(origin + path, {
        method,
        headers: {
            ...(cookie ? { cookie } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...(!['GET', 'HEAD'].includes(method) ? { origin } : {}),
            ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {}
    return { response, status: response.status, text, body: data };
}
function ok(result, status = 200) {
    assert.equal(result.status, status, result.text);
    return result.body?.data;
}
function failed(result, status, code) {
    assert.equal(result.status, status, result.text);
    if (code) assert.equal(result.body.error.code, code);
}
async function withRouter(operation, extra) {
    const instance = await runtime(worker, extra);
    try {
        const login = await request(instance, '/api/auth/login', {
            method: 'POST', body: { token: 'test-only-admin-credential-0123456789abcdef' },
        });
        ok(login);
        instance.cookie = login.response.headers.get('set-cookie').split(';')[0];
        instance.admin = (path, init = {}) => request(instance, path, { cookie: instance.cookie, ...init });
        await operation(instance);
    } finally { await instance.close(); }
}

test('router protects management APIs, exposes capabilities and returns JSON route errors', async () => {
    await withRouter(async (r) => {
        ok(await request(r, '/health'));
        failed(await request(r, '/api/subs'), 401, 'UNAUTHORIZED');
        const env = ok(await r.admin('/api/utils/env'));
        assert.equal(env.backend, 'Cloudflare Workers');
        assert.equal(env.capabilities.dynamicScripts, false);
        assert.ok(env.capabilities.targets.includes('QX'));
        assert.ok(env.capabilities.targets.includes('ShadowRocket'));
        failed(await r.admin('/api/does-not-exist'), 404, 'RESOURCE_NOT_FOUND');
        failed(await r.admin('/api/artifacts'), 501, 'UNSUPPORTED_FEATURE');
        const created = ok(await r.admin('/api/subs', { method: 'POST', body: subscription('one') }), 201);
        assert.equal(created.version, 1);
        const preview = ok(await r.admin('/api/preview/sub', { method: 'POST', body: subscription('one') }));
        assert.equal(preview.original.length, 1);
        assert.equal(preview.processed.length, 1);
        assert.ok(Array.isArray(preview.original));
    });
});

test('wrong share format cannot consume a counted token and concurrent usage cannot exceed its limit', async () => {
    await withRouter(async (r) => {
        ok(await r.admin('/api/subs', { method: 'POST', body: subscription('share') }), 201);
        const { token } = ok(await r.admin('/api/token', {
            method: 'POST',
            body: { payload: { type: 'sub', name: 'share', target: 'ClashMeta' }, options: { mode: 'count', count: 2 } },
        }));
        failed(await request(r, '/share/sub/share?token=' + token + '&target=JSON'), 403);
        let saved = await r.db.prepare('SELECT used_count FROM share_tokens WHERE token=?').bind(token).first();
        assert.equal(saved.used_count, 0);
        ok(await request(r, '/share/sub/share?token=' + token + '&target=ClashMeta'));
        const results = await Promise.all(Array.from({ length: 6 }, () =>
            request(r, '/share/sub/share?token=' + token + '&target=ClashMeta')));
        assert.equal(results.filter((result) => result.status === 200).length, 1);
        assert.equal(results.filter((result) => result.status === 403).length, 5);
        saved = await r.db.prepare('SELECT used_count FROM share_tokens WHERE token=?').bind(token).first();
        assert.equal(saved.used_count, 2);
    });
});

test('backup token targets and resource overrides reject before replacing existing data', async () => {
    await withRouter(async (r) => {
        ok(await r.admin('/api/subs', { method: 'POST', body: subscription('existing') }), 201);
        const before = JSON.parse((await r.admin('/api/storage')).text);
        const invalid = (tokenFields) => ({
            settings: {}, subs: [subscription('replacement')], collections: [], files: [],
            tokens: [{ token: 'b'.repeat(64), type: 'sub', name: 'replacement', ...tokenFields }],
        });
        failed(await r.admin('/api/storage', { method: 'POST', body: { content: invalid({ target: 'UnknownClient' }) } }),
            400, 'UNSUPPORTED_TARGET');
        failed(await r.admin('/api/storage', { method: 'POST', body: { content: invalid({ content: ss }) } }),
            422, 'UNSUPPORTED_FEATURE');
        failed(await r.admin('/api/storage', { method: 'POST', body: { content: invalid({
            process: [{ type: 'Sort Operator', args: 'asc' }],
        }) } }), 422, 'UNSUPPORTED_FEATURE');
        assert.deepEqual(JSON.parse((await r.admin('/api/storage')).text), before);
    });
});

test('restoring an expired duration token preserves expiry and does not renew authorization', async () => {
    await withRouter(async (r) => {
        const expired = Date.now() - 60000;
        const token = 'c'.repeat(64);
        ok(await r.admin('/api/storage', {
            method: 'POST', body: { content: {
                settings: {}, subs: [subscription('expired')], collections: [], files: [],
                tokens: [{
                    token, type: 'sub', name: 'expired', target: 'ClashMeta',
                    mode: 'duration', expiresIn: '1d', exp: expired,
                }],
            } },
        }));
        const stored = await r.db.prepare('SELECT exp FROM share_tokens WHERE token=?').bind(token).first();
        assert.equal(stored.exp, expired);
        failed(await request(r, '/share/sub/expired?token=' + token + '&target=ClashMeta'), 403, 'INVALID_TOKEN');
        const backup = JSON.parse((await r.admin('/api/storage')).text);
        assert.equal(backup.tokens[0].exp, expired);
    });
});

test('HEAD downloads and shares return metadata with empty bodies', async () => {
    await withRouter(async (r) => {
        ok(await r.admin('/api/subs', { method: 'POST', body: subscription('heads') }), 201);
        const download = await r.admin('/download/heads?target=ClashMeta', { method: 'HEAD' });
        assert.equal(download.status, 200);
        assert.equal(download.text, '');
        assert.match(download.response.headers.get('content-type'), /yaml/);
        assert.match(download.response.headers.get('cache-control'), /no-store/);
        const { token } = ok(await r.admin('/api/token', {
            method: 'POST', body: { payload: { type: 'sub', name: 'heads' }, options: {} },
        }));
        const share = await request(r, '/share/sub/heads?token=' + token + '&target=ClashMeta', { method: 'HEAD' });
        assert.equal(share.status, 200);
        assert.equal(share.text, '');
        assert.match(share.response.headers.get('content-disposition'), /heads/);
    });
});

test('logs support literal keyword filtering with case choice and reject regex mode', async () => {
    await withRouter(async (r) => {
        await r.db.batch([
            r.db.prepare('INSERT INTO logs VALUES(?,?,?,?)').bind('log-a', 1, 'info', 'Alpha_EVENT'),
            r.db.prepare('INSERT INTO logs VALUES(?,?,?,?)').bind('log-b', 2, 'info', 'alpha_second'),
            r.db.prepare('INSERT INTO logs VALUES(?,?,?,?)').bind('log-c', 3, 'info', 'literal.%_event'),
        ]);
        const exact = ok(await r.admin('/api/logs?keyword=Alpha&ignoreCase=false'));
        assert.deepEqual(exact.logs.map((entry) => entry.id), ['log-a']);
        assert.equal(exact.total, 1);
        const insensitive = ok(await r.admin('/api/logs?keyword=Alpha&ignoreCase=true'));
        assert.equal(insensitive.logs.length, 2);
        const literal = ok(await r.admin('/api/logs?keyword=' + encodeURIComponent('%_')));
        assert.deepEqual(literal.logs.map((entry) => entry.id), ['log-c']);
        failed(await r.admin('/api/logs?keyword=.&regex=true'), 422, 'UNSUPPORTED_FEATURE');
    });
});

test('download noCache query bypasses previously persisted source cache', async () => {
    let fetches = 0;
    await withRouter(async (r) => {
        ok(await r.admin('/api/subs', { method: 'POST', body: {
            name: 'remote', source: 'remote', url: 'https://upstream.example/sub', process: [],
        } }), 201);
        const first = await r.admin('/download/remote?target=ClashMeta');
        assert.equal(first.status, 200);
        assert.equal(fetches, 1);
        // waitUntil persists cache asynchronously; wait on a deterministic
        // database observation rather than a timing-sensitive fixed delay.
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await r.db.prepare('SELECT COUNT(*) AS n FROM resource_cache').first()).n) break;
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM resource_cache').first()).n, 1);
        assert.equal((await r.admin('/download/remote?target=ClashMeta')).status, 200);
        assert.equal(fetches, 1);
        assert.equal((await r.admin('/download/remote?target=ClashMeta&noCache=true')).status, 200);
        assert.equal(fetches, 2);
    }, { outboundService: async () => { fetches++; return new Response(ss); } });
});
