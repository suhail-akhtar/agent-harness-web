// A self-signed X.509 certificate built with node:crypto alone (DER by hand),
// so the demo can serve a certificate with any validity - an expired one - with
// no openssl in the image.

import crypto from 'node:crypto';

const len = (n) => (n < 0x80 ? Buffer.from([n]) : (() => { const b = []; while (n) { b.unshift(n & 0xff); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); })());
const tlv = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), len(body.length), body]); };
const seq = (...p) => tlv(0x30, ...p);
const set = (...p) => tlv(0x31, ...p);
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const nul = () => Buffer.from([0x05, 0x00]);
const utf8 = (s) => tlv(0x0c, Buffer.from(s, 'utf8'));
const octets = (b) => tlv(0x04, b);
const bits = (b) => tlv(0x03, Buffer.from([0]), b);
const explicit = (n, ...p) => tlv(0xa0 + n, ...p);
function oid(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const b = [v & 0x7f]; let x = v >> 7;
    while (x) { b.unshift((x & 0x7f) | 0x80); x >>= 7; }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}
function time(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const s = `${p(y % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? tlv(0x17, Buffer.from(s)) : tlv(0x18, Buffer.from(`${y}${s.slice(2)}`));
}
const name = (cn, o) => seq(set(seq(oid('2.5.4.3'), utf8(cn))), set(seq(oid('2.5.4.10'), utf8(o))));

/** { key, cert } PEM strings: a self-signed RSA certificate for `cn` valid from notBefore to notAfter. */
export function selfSigned({ cn = 'localhost', org = 'hwtest', notBefore, notAfter, dns = ['localhost'], ips = ['127.0.0.1'] }) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const alg = seq(oid('1.2.840.113549.1.1.11'), nul());
  const san = seq(...dns.map((d) => tlv(0x82, Buffer.from(d))), ...ips.map((ip) => tlv(0x87, Buffer.from(ip.split('.').map(Number)))));
  const ext = explicit(3, seq(seq(oid('2.5.29.17'), octets(san)), seq(oid('2.5.29.19'), octets(seq()))));
  const tbs = seq(
    explicit(0, int(Buffer.from([2]))),
    int(crypto.randomBytes(8)),
    alg,
    name(cn, org),
    seq(time(notBefore), time(notAfter)),
    name(cn, org),
    publicKey.export({ type: 'spki', format: 'der' }),
    ext,
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const der = seq(tbs, alg, bits(sig));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
  return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }), cert: pem };
}
