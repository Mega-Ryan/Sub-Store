import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileParsers, staticParsersPlugin } from './conversion/compile-parsers.mjs';

export const root = path.dirname(fileURLToPath(import.meta.url));
export const prepare = compileParsers;
export function options(entry, outfile, overrides = {}) {
  return {
    absWorkingDir: root, entryPoints: [entry], outfile, bundle: true,
    format: 'esm', platform: 'browser', target: 'es2022',
    nodePaths: [path.join(root, 'node_modules')],
    alias: {
      '@/core/app': path.join(root, 'conversion/app.js'),
      '@/utils/geo': path.join(root, 'conversion/geo.js'),
      '@': path.resolve(root, '../src'),
    },
    external: ['node:crypto', 'node:async_hooks'],
    plugins: [staticParsersPlugin()],
    legalComments: 'linked', metafile: true, ...overrides,
  };
}
