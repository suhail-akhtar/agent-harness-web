import crypto from 'node:crypto';

// AWS Signature Version 4, with node:crypto alone (no SDK): the canonical request,
// the string to sign, the derived key and the Authorization header, as AWS
// documents them. Checked against AWS's published test vectors (test/vault.test.ts).

export interface AwsCredentials { accessKeyId: string; secretAccessKey: string; sessionToken?: string }

export interface SignInput {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** The request time (default: now). */
  date?: Date;
}

const sha256 = (s: string | Buffer) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k: Buffer | string, s: string) => crypto.createHmac('sha256', k).update(s).digest();

/** RFC 3986 encoding, as SigV4 wants it (encodeURIComponent leaves !'()* alone). */
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** The headers to send: the given ones plus x-amz-date (and the session token), and Authorization. */
export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const when = amzDate(i.date ?? new Date());
  const day = when.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, 'x-amz-date': when };
  if (i.credentials.sessionToken) headers['x-amz-security-token'] = i.credentials.sessionToken;
  if (!Object.keys(headers).some((k) => k.toLowerCase() === 'host')) headers.host = u.host;
  const canonHeaders = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) canonHeaders.set(k.toLowerCase(), String(v).trim().replace(/\s+/g, ' '));
  const names = [...canonHeaders.keys()].sort();
  const signedHeaders = names.join(';');
  // Each path segment encoded once (S3 is the exception and is not used here).
  const canonPath = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const query = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] === b[0] ? (a[1]! < b[1]! ? -1 : 1) : a[0]! < b[0]! ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [i.method.toUpperCase(), canonPath, query, ...names.map((n) => `${n}:${canonHeaders.get(n)}`), '', signedHeaders, sha256(i.body ?? '')].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', when, scope, sha256(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(toSign).digest('hex');
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
