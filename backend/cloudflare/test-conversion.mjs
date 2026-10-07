import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { options, prepare } from './bundle.mjs';

await mkdir('test/.generated', { recursive: true });
await prepare();
await build(options('conversion/conversion.test.js', 'test/.generated/conversion.test.mjs', {
  platform: 'browser', external: ['node:crypto', 'node:async_hooks', 'node:test', 'node:assert/strict'],
}));
const result = spawnSync(process.execPath, ['--test', 'test/.generated/conversion.test.mjs'], { stdio: 'inherit' });
process.exit(result.status ?? 1);
