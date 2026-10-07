import { Buffer } from 'buffer';
import { parse } from './qx.generated.js';
function decodeQxAlpn(raw) {
    if (typeof raw !== 'string') return undefined;
    const hex = raw.trim().replace(/:/g, '');
    if (!hex || hex.length % 2 || /[^0-9a-f]/i.test(hex)) return undefined;

    const bytes = Buffer.from(hex, 'hex');
    const alpn = [];
    for (let offset = 0; offset < bytes.length; ) {
        const length = bytes[offset++];
        if (!length || offset + length > bytes.length) return undefined;
        alpn.push(bytes.subarray(offset, offset + length).toString('utf8'));
        offset += length;
    }
    return alpn;
}


const parser = {
    parse(input, options) {
        const proxy = parse(input, options);
        const alpn = decodeQxAlpn(proxy['tls-alpn']);
        if (alpn) proxy.alpn = alpn;
        return proxy;
    },
};
export default function getParser() { return parser; }
