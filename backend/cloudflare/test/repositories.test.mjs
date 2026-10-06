import test from 'node:test';
import assert from 'node:assert/strict';
import { runtime, repositoryWorker } from './runtime-helper.mjs';

const ss = 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:8388#Hong%20Kong';
const subscription = (name) => ({ name, source: 'local', content: ss, process: [] });
const success = (result) => {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    return result.body.data;
};
const failed = (result, status, code) => {
    assert.equal(result.status, status, JSON.stringify(result.body));
    assert.equal(result.body.error.code, code);
};
async function withRuntime(operation, extra) {
    const instance = await runtime(repositoryWorker, extra);
    try { await operation(instance); } finally { await instance.close(); }
}

test('stale entity versions roll back linked collection membership and revision', async () => {
    await withRuntime(async (r) => {
        success(await r.call('create', { kind: 'sub', data: subscription('a') }));
        success(await r.call('create', { kind: 'sub', data: subscription('b') }));
        const col = success(await r.call('create', {
            kind: 'col', data: { name: 'collection', subscriptions: ['a'], process: [] },
        }));
        const updated = success(await r.call('update', {
            kind: 'col', name: 'collection', version: col.version,
            data: { name: 'collection', subscriptions: ['b'], process: [] },
        }));
        const state = success(await r.call('state'));
        failed(await r.call('update', {
            kind: 'col', name: 'collection', version: col.version,
            data: { name: 'bad-rename', subscriptions: ['a'], process: [] },
        }), 409, 'VERSION_CONFLICT');
        const [current] = success(await r.call('list', { kind: 'col' }));
        assert.equal(current.name, 'collection');
        assert.deepEqual(current.subscriptions, ['b']);
        assert.equal(current.version, updated.version);
        assert.deepEqual(success(await r.call('state')), state);
        assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM mutation_guards').first()).n, 0);
    });
});

test('global revision and duplicate-name guards roll back the entire batch', async () => {
    await withRuntime(async (r) => {
        const initial = success(await r.call('state'));
        success(await r.call('create', { kind: 'sub', data: subscription('same') }));
        const before = success(await r.call('state'));
        const settings = success(await r.call('settings'));
        failed(await r.call('stale-mutation', { revision: initial.revision }), 409, 'VERSION_CONFLICT');
        assert.deepEqual(success(await r.call('settings')), settings);
        failed(await r.call('create', { kind: 'sub', data: subscription('same') }), 409, 'VERSION_CONFLICT');
        assert.equal(success(await r.call('list', { kind: 'sub' })).length, 1);
        assert.deepEqual(success(await r.call('state')), before);
    });
});

test('subscription identity survives rename and deletion cleans collection references', async () => {
    await withRuntime(async (r) => {
        const sub = success(await r.call('create', { kind: 'sub', data: subscription('old') }));
        success(await r.call('create', { kind: 'col', data: { name: 'col', subscriptions: ['old'], process: [] } }));
        const id = (await r.db.prepare("SELECT id FROM entities WHERE kind='sub'").first()).id;
        await r.db.prepare("INSERT INTO share_tokens(token,target_id,type,data,created_at) VALUES(?,?,?,'{}',?)")
            .bind('test-token', id, 'sub', Date.now()).run();
        const renamed = success(await r.call('update', {
            kind: 'sub', name: 'old', version: sub.version, data: subscription('new'),
        }));
        assert.deepEqual(success(await r.call('list', { kind: 'col' }))[0].subscriptions, ['new']);
        assert.equal((await r.db.prepare("SELECT id FROM entities WHERE kind='sub'").first()).id, id);
        success(await r.call('remove', { kind: 'sub', name: 'new', version: renamed.version }));
        assert.deepEqual(success(await r.call('list', { kind: 'col' }))[0].subscriptions, []);
        assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM share_tokens').first()).n, 0);
    });
});

test('sorting requires an exact permutation and settings require current versions', async () => {
    await withRuntime(async (r) => {
        const a = success(await r.call('create', { kind: 'sub', data: subscription('a') }));
        const b = success(await r.call('create', { kind: 'sub', data: subscription('b') }));
        const before = success(await r.call('state'));
        failed(await r.call('sort', { kind: 'sub', orders: ['a', 'a'] }), 400, 'INVALID_PAYLOAD');
        assert.deepEqual(success(await r.call('state')), before);
        const sorted = success(await r.call('sort', { kind: 'sub', orders: ['b', 'a'] }));
        assert.deepEqual(sorted.map((entry) => entry.name), ['b', 'a']);
        assert.deepEqual(sorted.map((entry) => entry.version), [b.version, a.version]);
        const initial = success(await r.call('settings'));
        const updated = success(await r.call('patch-settings', { _version: initial._version, theme: 'dark' }));
        failed(await r.call('patch-settings', { _version: initial._version, theme: 'light' }), 409, 'VERSION_CONFLICT');
        assert.deepEqual(success(await r.call('settings')), updated);
    });
});

test('unsupported configurations and non-text content fail before any database write', async () => {
    await withRuntime(async (r) => {
        const before = success(await r.call('state'));
        failed(await r.call('create', {
            kind: 'sub', data: { ...subscription('array'), content: ['node'] },
        }), 400, 'INVALID_PAYLOAD');
        failed(await r.call('create', {
            kind: 'sub', data: { ...subscription('script'), process: [{ type: 'Script Operator', disabled: true }] },
        }), 422, 'UNSUPPORTED_FEATURE');
        failed(await r.call('create', {
            kind: 'file', data: { name: 'template', content: 'x', process: [{ type: 'Sort Operator', args: 'asc' }] },
        }), 422, 'UNSUPPORTED_FEATURE');
        assert.deepEqual(success(await r.call('state')), before);
        assert.deepEqual(success(await r.call('list', { kind: 'sub' })), []);
        assert.deepEqual(success(await r.call('list', { kind: 'file' })), []);
    });
});

test('cache refresh advances generation and deletes saved responses atomically', async () => {
    await withRuntime(async (r) => {
        const before = success(await r.call('state'));
        await r.db.prepare('INSERT INTO resource_cache VALUES(?,?,?,?,?,?)')
            .bind('key', before.cache_epoch, 'content', null, Date.now() + 100000, Date.now()).run();
        success(await r.call('clear-cache'));
        const after = success(await r.call('state'));
        assert.equal(after.cache_epoch, before.cache_epoch + 1);
        assert.equal(after.revision, before.revision + 1);
        assert.equal((await r.db.prepare('SELECT COUNT(*) AS n FROM resource_cache').first()).n, 0);
    });
});

test('login issues secure hashed sessions, checks origin, expires and revokes them', async () => {
    await withRuntime(async (r) => {
        const origin = 'https://test.example';
        failed(await r.call('login', { token: 'wrong' }, { headers: { origin: 'https://other.example' } }), 403, 'INVALID_ORIGIN');
        failed(await r.call('login', { token: 'wrong' }, { headers: { origin } }), 401, 'INVALID_CREDENTIAL');
        const login = await r.call('login', { token: 'test-only-admin-credential-0123456789abcdef' }, { headers: { origin } });
        success(login);
        const cookie = login.response.headers.get('set-cookie');
        assert.match(cookie, /Secure; HttpOnly; SameSite=Strict; Max-Age=300/);
        const cookieHeader = cookie.split(';')[0];
        const token = cookieHeader.split('=')[1];
        const saved = await r.db.prepare('SELECT token_hash FROM admin_sessions').first();
        assert.notEqual(saved.token_hash, token);
        assert.equal(saved.token_hash.length, 64);
        assert.equal(success(await r.call('session', {}, { headers: { cookie: cookieHeader } })).authenticated, true);
        success(await r.call('logout', {}, { headers: { cookie: cookieHeader, origin } }));
        failed(await r.call('require-session', {}, { headers: { cookie: cookieHeader } }), 401, 'UNAUTHORIZED');
        const another = await r.call('login', { token: 'test-only-admin-credential-0123456789abcdef' }, { headers: { origin } });
        success(another);
        await r.db.prepare('UPDATE admin_sessions SET expires_at=?').bind(Date.now() - 1).run();
        assert.equal(success(await r.call('session', {}, {
            headers: { cookie: another.response.headers.get('set-cookie').split(';')[0] },
        })).authenticated, false);
    });
});

test('login rate limit is enforced atomically per caller IP', async () => {
    await withRuntime(async (r) => {
        const headers = { origin: 'https://test.example', 'cf-connecting-ip': '198.51.100.5' };
        for (let attempt = 0; attempt < 20; attempt++) {
            failed(await r.call('login', { token: 'wrong' }, { headers }), 401, 'INVALID_CREDENTIAL');
        }
        failed(await r.call('login', { token: 'wrong' }, { headers }), 429, 'TOO_MANY_ATTEMPTS');
        failed(await r.call('login', { token: 'wrong' }, {
            headers: { ...headers, 'cf-connecting-ip': '198.51.100.6' },
        }), 401, 'INVALID_CREDENTIAL');
    });
});

test('download runtime converts local content, preserves plain files and rejects unsupported source features', async () => {
    await withRuntime(async (r) => {
        const converted = success(await r.call('convert', { kind: 'sub', data: subscription('local'), target: 'ClashMeta' }));
        assert.equal(converted.proxies.length, 1);
        assert.match(converted.output, /example.com/);
        const file = success(await r.call('file', { data: { name: 'text', source: 'local', content: 'hello\nworld' } }));
        assert.equal(file.content, 'hello\nworld');
        failed(await r.call('download', { url: 'file:///secret' }), 422, 'UNSUPPORTED_FEATURE');
        failed(await r.call('download', { url: 'https://example.com#insecure=true' }), 422, 'UNSUPPORTED_FEATURE');
        failed(await r.call('download', { url: 'https://example.com', options: { headers: { Cookie: 'secret' } } }), 422, 'UNSUPPORTED_FEATURE');
        const flow = success(await r.call('flow', { value: 'upload=1; download=2; total=100; expire=2000000000' }));
        assert.equal(flow.usage.download, 2);
        assert.equal(flow.total, 100);
        failed(await r.call('flow', { value: null }), 404, 'NO_FLOW_INFO');
    });
});

test('remote downloads cache responses, preserve flow metadata and honor refresh and noCache', async () => {
    let calls = 0;
    await withRuntime(async (r) => {
        const url = 'https://upstream.example/sub';
        const first = success(await r.call('download', { url }));
        assert.equal(first.content, ss);
        assert.equal(first.flow, 'upload=1; download=2; total=100');
        success(await r.call('download', { url }));
        assert.equal(calls, 1);
        success(await r.call('clear-cache'));
        success(await r.call('download', { url }));
        assert.equal(calls, 2);
        success(await r.call('download', { url, options: { noCache: true } }));
        assert.equal(calls, 3);
    }, {
        outboundService: async () => {
            calls++;
            return new Response(ss, { headers: { 'subscription-userinfo': 'upload=1; download=2; total=100' } });
        },
    });
});

test('cross-origin upstream redirects strip authorization and reject private destinations', async () => {
    const seen = [];
    await withRuntime(async (r) => {
        success(await r.call('download', {
            url: 'https://first.example/sub',
            options: { headers: { Authorization: 'test-only-upstream-key' } },
        }));
        assert.equal(seen[0].authorization, 'test-only-upstream-key');
        assert.equal(seen[1].authorization, null);
        failed(await r.call('download', { url: 'https://first.example/private' }), 422, 'UNSUPPORTED_FEATURE');
    }, {
        outboundService: async (request) => {
            const url = new URL(request.url);
            seen.push({ host: url.hostname, authorization: request.headers.get('authorization') });
            if (url.pathname === '/private') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
            if (url.hostname === 'first.example') return new Response(null, { status: 302, headers: { location: 'https://second.example/sub' } });
            return new Response(ss);
        },
    });
});

test('an old in-flight download cannot erase or repopulate the refreshed cache generation', async () => {
    let releaseSlow;
    let started;
    const slowStarted = new Promise((resolve) => { started = resolve; });
    await withRuntime(async (r) => {
        const pending = r.call('download', { url: 'https://upstream.example/slow' });
        await slowStarted;
        success(await r.call('clear-cache'));
        const current = success(await r.call('state'));
        success(await r.call('download', { url: 'https://upstream.example/fast' }));
        releaseSlow();
        success(await pending);
        const rows = (await r.db.prepare('SELECT epoch FROM resource_cache').all()).results;
        assert.deepEqual(rows.map((row) => row.epoch), [current.cache_epoch]);
    }, {
        outboundService: async (request) => {
            if (new URL(request.url).pathname !== '/slow') return new Response(ss);
            started();
            return await new Promise((resolve) => {
                releaseSlow = () => resolve(new Response(ss));
            });
        },
    });
});

test('backup restoration preserves base data, collection links and counted tokens', async () => {
    await withRuntime(async (r) => {
        success(await r.call('import', { content: {
            schemaVersion: 'cloudflare-basic-1',
            settings: { theme: 'dark' },
            subs: [subscription('a')],
            collections: [{ name: 'col', subscriptions: ['a'], process: [] }],
            files: [{ name: 'plain', source: 'local', content: 'hello', process: [] }],
            tokens: [{
                name: 'a', type: 'sub', token: 'a'.repeat(64),
                mode: 'count', count: 3, usedCount: 1,
            }],
        } }));
        const exported = success(await r.call('export'));
        assert.equal(exported.subs[0].content, ss);
        assert.deepEqual(exported.collections[0].subscriptions, ['a']);
        assert.equal(exported.files[0].content, 'hello');
        assert.equal(exported.settings.theme, 'dark');
        assert.equal(exported.tokens[0].count, 3);
        assert.equal(exported.tokens[0].usedCount, 1);
        success(await r.call('import', { content: Buffer.from(JSON.stringify(exported)).toString('base64') }));
        assert.deepEqual(success(await r.call('export')).collections[0].subscriptions, ['a']);
    });
});

test('invalid backup members and scripts cannot partially replace existing data', async () => {
    await withRuntime(async (r) => {
        success(await r.call('create', { kind: 'sub', data: subscription('existing') }));
        const before = success(await r.call('export'));
        const state = success(await r.call('state'));
        failed(await r.call('import', { content: {
            settings: {}, subs: [subscription('replacement')],
            collections: [{ name: 'missing', subscriptions: ['absent'], process: [] }],
        } }), 400, 'INVALID_BACKUP_DATA');
        failed(await r.call('import', { content: {
            settings: {}, subs: [{ ...subscription('replacement'), process: [{ type: 'Script Filter' }] }],
        } }), 422, 'UNSUPPORTED_FEATURE');
        assert.deepEqual(success(await r.call('export')), before);
        assert.deepEqual(success(await r.call('state')), state);
    });
});
