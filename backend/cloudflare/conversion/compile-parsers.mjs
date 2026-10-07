// Build-only: compile trusted upstream grammar to static JavaScript before
// deployment. Peggy's runtime compiler must never enter the Worker bundle.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import peggy from 'peggy';

const directory = path.dirname(fileURLToPath(import.meta.url));
const names = ['surge', 'loon', 'qx'];

export async function compileParsers() {
    const generatedDirectory = path.join(directory, 'parsers');
    await mkdir(generatedDirectory, { recursive: true });
    for (const name of names) {
        const sourcePath = path.resolve(
            directory, '../../src/core/proxy-utils/parsers/peggy', name + '.js',
        );
        const source = await readFile(sourcePath, 'utf8');
        const marker = 'const grammars = String.raw' + String.fromCharCode(96);
        const start = source.indexOf(marker);
        const end = source.lastIndexOf(String.fromCharCode(96) + ';');
        if (start < 0 || end <= start) throw new Error('Cannot extract grammar: ' + name);
        const grammar = source.slice(start + marker.length, end);
        if (grammar.includes('$' + '{')) throw new Error('Unexpected grammar interpolation: ' + name);
        const generated = peggy.generate(grammar, {
            output: 'source',
            format: 'es',
            grammarSource: sourcePath,
        });
        // Helpers use no eval/new Function; this output is static bundled code.
        await writeFile(path.join(generatedDirectory, name + '.generated.js'),
            '// Generated from trusted Sub-Store grammar (AGPL-3.0). Do not edit.\n' + generated);
        let wrapper;
        if (name === 'qx') {
            const helperStart = source.indexOf('function decodeQxAlpn(');
            if (helperStart < 0 || helperStart >= start) throw new Error('Missing QX ALPN helper');
            wrapper = [
                "import { Buffer } from 'buffer';",
                "import { parse } from './qx.generated.js';",
                source.slice(helperStart, start),
                'const parser = {',
                '    parse(input, options) {',
                '        const proxy = parse(input, options);',
                "        const alpn = decodeQxAlpn(proxy['tls-alpn']);",
                '        if (alpn) proxy.alpn = alpn;',
                '        return proxy;',
                '    },',
                '};',
                'export default function getParser() { return parser; }',
            ].join('\n');
        } else {
            wrapper = [
                "import { parse } from './" + name + ".generated.js';",
                'const parser = { parse };',
                'export default function getParser() { return parser; }',
            ].join('\n');
        }
        await writeFile(path.join(generatedDirectory, name + '.js'), wrapper + '\n');
    }
}

export function staticParsersPlugin() {
    return {
        name: 'sub-store-static-parsers',
        setup(build) {
            build.onResolve({ filter: /(?:^|\/)peggy\/(surge|loon|qx)(?:\.js)?$/ }, (args) => {
                const name = args.path.match(/\/(surge|loon|qx)(?:\.js)?$/)[1];
                return { path: path.join(directory, 'parsers', name + '.js') };
            });
        },
    };
}
