import test from 'node:test';
import assert from 'node:assert/strict';
import { Base64 } from 'js-base64';
import { parse as parseYaml } from 'yaml';
import { convert, validateProcessors, SUPPORTED_TARGETS } from './index.js';
import { generateFingerprint } from './certificate.js';

const ss = 'ss://YWVzLTEyOC1nY206cGFzcw@example.com:8388#Hong%20Kong';
const trojan = 'trojan://password@jp.example.com:443?security=tls&sni=jp.example.com#Japan';
const nodes = ss + '\n' + trojan;

test('URI and base64 sources retain normalized fields and source labels', async () => {
    const result = await convert(
        [{ content: Base64.encode(nodes), name: 'source', displayName: '我的订阅' }],
        'JSON',
    );
    assert.equal(result.originalProxies.length, 2);
    const [first, second] = result.proxies;
    assert.equal(first.type, 'ss');
    assert.equal(first.password, 'pass');
    assert.equal(first.cipher, 'aes-128-gcm');
    assert.equal(first.port, 8388);
    assert.equal(first._subName, '我的订阅');
    assert.equal(second.type, 'trojan');
    assert.equal(second.sni, 'jp.example.com');
    assert.equal(JSON.parse(result.output).length, 2);
});

test('common client outputs preserve a supported Shadowsocks node', async () => {
    for (const target of [
        'URI', 'Clash', 'ClashMeta', 'mihomo', 'Stash', 'sing-box',
        'Surge', 'Loon', 'QX', 'Shadowrocket',
    ]) {
        const result = await convert(ss, target);
        assert.equal(result.proxies.length, 1, target);
        assert.equal(typeof result.output, 'string', target);
        assert.ok(result.output.length > 0, target);
        assert.ok(result.output.includes('example.com'), target);
    }
    assert.ok(SUPPORTED_TARGETS.includes('ClashMeta'));
});

test('precompiled Surge, Loon and QX parsers round-trip native output', async () => {
    for (const target of ['Surge', 'Loon', 'QX']) {
        const produced = await convert(ss, target);
        const reparsed = await convert(produced.output, 'JSON');
        assert.equal(reparsed.proxies.length, 1, target);
        assert.equal(reparsed.proxies[0].server, 'example.com', target);
        assert.equal(reparsed.proxies[0].password, 'pass', target);
    }
});

test('precompiled QX parser preserves the upstream ALPN decoding wrapper', async () => {
    const result = await convert(
        'trojan=example.com:443,password=pass,over-tls=true,tls-alpn=02:68:32,tag=QX',
        'JSON',
    );
    assert.equal(result.proxies.length, 1);
    assert.deepEqual(result.proxies[0].alpn, ['h2']);
});

test('Clash YAML VLESS Reality short-id normalization is preserved', async () => {
    const content = [
        'proxies:',
        '  - name: VLESS',
        '    type: vless',
        '    server: example.com',
        '    port: 443',
        '    uuid: 12345678-1234-1234-1234-123456789abc',
        '    tls: true',
        '    reality-opts:',
        '      public-key: publickey',
        '      short-id: 0088',
    ].join('\n');
    const result = await convert(content, 'ClashMeta');
    assert.equal(result.proxies[0]['reality-opts']['short-id'], '0088');
    const yaml = parseYaml(result.output);
    const exported = Array.isArray(yaml) ? yaml : yaml.proxies;
    assert.equal(exported[0]['reality-opts']['short-id'], '0088');
});

test('per-subscription processing runs before collection processing and preserves preview', async () => {
    const result = await convert([
        { content: nodes, processors: [{ type: 'Type Filter', args: ['ss'] }] },
        { content: trojan },
    ], 'JSON', [
        { type: 'Regex Rename Operator', args: [{ expr: 'Hong Kong', now: '香港' }] },
        { type: 'Flag Operator', args: { mode: 'add', tw: 'tw' } },
        { type: 'Sort Operator', args: 'asc' },
    ]);
    assert.equal(result.originalProxies.length, 3);
    assert.equal(result.proxies.length, 2);
    assert.ok(result.proxies.some((node) => node.name.includes('🇭🇰 香港')));
    assert.equal(result.originalProxies[0].name, 'Hong Kong');
});

test('duplicate delete handles names that match object prototype keys', async () => {
    const content = ss.replace('Hong%20Kong', 'constructor') + '\n' +
        ss.replace('Hong%20Kong', 'constructor');
    const result = await convert(content, 'JSON', [
        { type: 'Handle Duplicate Operator', args: { action: 'delete', field: ['name'] } },
    ]);
    assert.equal(result.proxies.length, 1);
    assert.equal(result.proxies[0].name, 'constructor');
});

test('conditional EXISTS treats null and missing attributes as absent', async () => {
    const result = await convert(ss, 'JSON', [{
        type: 'Conditional Filter',
        args: { rule: { attr: 'missing', proposition: 'EXISTS' } },
    }]);
    assert.equal(result.proxies.length, 0);
});

test('unsupported and disabled script actions fail explicitly before conversion', async () => {
    for (const type of [
        'Script Operator', 'Script Filter', 'Response Transformer',
        'Resolve Domain Operator', 'Add Proxies From Subscription Operator',
    ]) {
        await assert.rejects(convert(ss, 'JSON', [{ type, disabled: true }]),
            (error) => error.code === 'UNSUPPORTED_FEATURE' && error.status === 422);
    }
});

test('invalid expressions, unknown action args and unknown output options reject', async () => {
    assert.throws(() => validateProcessors([
        { type: 'Regex Filter', args: { regex: ['['] } },
    ]), (error) => error.code === 'INVALID_ARGUMENT');
    assert.throws(() => validateProcessors([
        { type: 'Quick Setting Operator', args: { script: 'throw 1' } },
    ]), (error) => error.code === 'UNSUPPORTED_FEATURE');
    await assert.rejects(convert(ss, 'JSON', [], { options: { _merged: {} } }),
        (error) => error.code === 'UNSUPPORTED_FEATURE');
    await assert.rejects(convert(ss, 'constructor'),
        (error) => error.code === 'UNSUPPORTED_TARGET');
});

test('local certificate files and external process nodes are not silently accepted', async () => {
    await assert.rejects(convert(JSON.stringify({
        name: 'local-ca', type: 'trojan', server: 'example.com',
        port: 443, password: 'password', _ca: '/secret.pem',
    }), 'JSON'), (error) => error.code === 'UNSUPPORTED_FEATURE');
    await assert.rejects(convert('external = external, exec = "/usr/bin/ssh", local-port = 1080', 'JSON'),
        (error) => error.code === 'UNSUPPORTED_FEATURE');
});

test('request warnings are isolated and contain no subscription credentials', async () => {
    const [invalid, valid] = await Promise.all([
        convert('not-a-proxy password=do-not-leak', 'JSON'),
        convert(ss, 'JSON'),
    ]);
    assert.ok(invalid.warnings.length > 0);
    assert.equal(valid.warnings.length, 0);
    assert.ok(!invalid.warnings.join(' ').includes('do-not-leak'));
});

test('inline certificate fingerprints use SHA-256 without jsrsasign', () => {
    assert.equal(generateFingerprint(
        '-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----',
    ), 'BA:78:16:BF:8F:01:CF:EA:41:41:40:DE:5D:AE:22:23:B0:03:61:A3:96:17:7A:9C:B4:10:FF:61:F2:00:15:AD');
});
