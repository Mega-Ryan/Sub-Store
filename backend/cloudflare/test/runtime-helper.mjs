import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { options, prepare, root } from '../bundle.mjs';

let preparation;
export async function runtime(source, extra = {}) {
    preparation ??= prepare();
    await preparation;
    const compiled = await build(options('test/.generated/inline.js', 'test/.generated/inline.js', {
        entryPoints: undefined,
        stdin: { contents: source, sourcefile: 'test-worker.js', resolveDir: root, loader: 'js' },
        write: false,
    }));
    const script = compiled.outputFiles.find((file) => file.path.endsWith('.js')).text;
    const mf = new Miniflare(convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: '2026-10-06',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        bindings: {
            PUBLIC_ORIGIN: 'https://test.example',
            ADMIN_LOGIN_TOKEN: 'test-only-admin-credential-0123456789abcdef',
            SESSION_TTL_SECONDS: '300',
            RESOURCE_CACHE_TTL_SECONDS: '300',
        },
        ...extra,
    }));
    const db = await mf.getD1Database('DB');
    const migration = await readFile(path.join(root, 'migrations/0001_basic.sql'), 'utf8');
    // D1 exec treats newlines as statement boundaries. Keep trigger bodies
    // intact; each prepared statement is one complete migration statement.
    const trigger = migration.match(/CREATE TRIGGER[\s\S]+?END;/)?.[0];
    const ordinary = migration
        .replace(/^--.*$/gm, '')
        .replace(/CREATE TRIGGER[\s\S]+?END;/, '');
    const statements = ordinary.split(';').map((sql) => sql.trim()).filter(Boolean);
    for (const sql of statements) await db.prepare(sql).run();
    if (trigger) await db.prepare(trigger).run();
    return {
        mf,
        db,
        async call(op, input = {}, init = {}) {
            const response = await mf.dispatchFetch('https://test.example/' + op, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...init.headers },
                body: JSON.stringify(input),
            });
            return { response, status: response.status, body: await response.json() };
        },
        async close() { await mf.dispose(); },
    };
}

export const repositoryWorker = `
import * as repo from './repositories.js';
import * as auth from './auth.js';
import * as validation from './validation.js';
import * as downloads from './downloads.js';
import * as backup from './backup.js';
import { json, errorResponse } from './errors.js';

export default {
    async fetch(request, env, ctx) {
        try {
            const op = new URL(request.url).pathname.slice(1);
            if (op === 'login') return await auth.login(request, env);
            if (op === 'logout') return await auth.logout(request, env);
            if (op === 'session') return json({ authenticated: !!await auth.session(request, env) });
            if (op === 'require-session') { await auth.requireSession(request, env); return json(true); }
            const input = await validation.readJSON(request);
            let value;
            switch (op) {
                case 'create': value = await repo.create(env.DB, input.kind, validation.entity(input.kind, input.data)); break;
                case 'update': value = await repo.update(env.DB, input.kind, input.name, validation.entity(input.kind, input.data), input.version); break;
                case 'remove': value = await repo.remove(env.DB, input.kind, input.name, input.version); break;
                case 'list': value = await repo.list(env.DB, input.kind); break;
                case 'sort': value = await repo.sort(env.DB, input.kind, input.orders); break;
                case 'state': value = await repo.state(env.DB); break;
                case 'settings': value = await repo.getSettings(env.DB); break;
                case 'patch-settings': validation.supported(input); value = await repo.patchSettings(env.DB, input); break;
                case 'clear-cache': value = await repo.clearCache(env.DB); break;
                case 'download': value = await new downloads.DownloadContext(env).download(input.url, input.options); break;
                case 'convert': value = await downloads.conversion(input.kind, input.data, input.target, env, ctx); break;
                case 'file': value = await downloads.fileContent(input.data, env, ctx); break;
                case 'flow': value = downloads.flowInfo(input.value); break;
                case 'export': value = await backup.exportBackup(env.DB); break;
                case 'import': value = await backup.importBackup(env.DB, input.content); break;
                case 'stale-mutation':
                    value = await repo.mutate(env.DB, [
                        env.DB.prepare("UPDATE settings SET data='{}',version=version+1 WHERE key='settings'"),
                    ], { revision: input.revision }); break;
                default: throw new Error('Unknown test operation');
            }
            return json(value ?? null);
        } catch (error) { return errorResponse(error); }
    },
};
`;
