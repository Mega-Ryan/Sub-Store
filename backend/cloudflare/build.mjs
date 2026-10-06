import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { options, prepare } from './bundle.mjs';

await mkdir('dist', { recursive: true });
await prepare();
const result = await build(options('worker.ts', 'dist/worker.js', { minify: true }));
const forbidden = Object.keys(result.metafile.inputs).filter(name =>
  /src\/(vendor\/open-api|runtime\/|restful\/sync|utils\/(gist|dns|script-resource-cache))/.test(name));
if (forbidden.length) throw new Error('Unsupported runtime dependency in bundle: ' + forbidden.join(', '));
await writeFile('dist/metafile.json', JSON.stringify(result.metafile, null, 2));
console.log('Worker bundle verified; inputs:', Object.keys(result.metafile.inputs).length);
