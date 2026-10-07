import { createHash } from 'node:crypto';
import { Buffer } from 'buffer';

// Replaces jsrsasign for the sole certificate operation used in normalization.
// node:crypto is supported by Workers' Node compatibility runtime.
export function generateFingerprint(pem) {
    if (typeof pem !== 'string') throw new TypeError('Invalid PEM certificate');
    const match = pem.match(
        /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/,
    );
    if (!match) throw new TypeError('Invalid PEM certificate');
    const base64 = match[1].replace(/\s/g, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
        throw new TypeError('Invalid PEM certificate');
    }
    return createHash('sha256')
        .update(Buffer.from(base64, 'base64'))
        .digest('hex')
        .match(/.{2}/g)
        .join(':')
        .toUpperCase();
}

export default { generateFingerprint };
