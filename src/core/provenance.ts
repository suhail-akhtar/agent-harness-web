// Where a call sends data, and whether the person named it: the untrusted-content guard's
// view of a call's destinations. Every way out of a session that read outside content is
// asked (permissions.ts); a call whose every destination the person named themselves -
// in their own messages, never the agent's or a page's - is not the guard's to ask about,
// and one that sends to a destination the person never named is asked even in bypass when it
// acts on another system (a message, a payment, a service). From the watch_opus E5/E6 runs:
// checking each destination's origin cut AgentDojo attacks from ~9% to ~2.4% at almost no
// cost to normal work. Unlike that research code, matching is exact on whole values of
// typed fields (no substrings, no list of known domain endings), and nothing read from a
// tool's output ever becomes known.

/** A destination, normalized: email:<address>, host:<name>, iban:<IBAN>, phone:<digits>, or raw:<value> (none of those: never known). */
export type Destination = string;

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const IBAN = /^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}$/;
// Field names whose values say where a call goes.
const DEST_KEY = /(?:^|[_-])(?:to|cc|bcc)$|recipient|email|e_?mail|url|uri|href|link|webhook|endpoint|host|domain|dest|iban|account|payee|beneficiary|phone|channel|address/i;

// Endings that are file names far more often than domains, in what a person types.
const FILE_EXT = /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|ya?ml|toml|py|ipynb|sh|ps1|bat|css|scss|html?|xml|csv|tsv|pdf|docx?|xlsx?|pptx?|png|jpe?g|gif|svg|webp|zip|gz|tar|lock|log|env|ini|cfg|conf|sql|rs|go|java|kt|rb|php|cs|cpp|hpp|h|c|vue|svelte|glb|gltf|wav|mp3|mp4)$/i;

const host = (h: string) => h.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');

/** One value of a destination field, normalized. */
export function destinationOf(value: string): Destination {
  const v = value.trim();
  const mailto = /^mailto:(.+)$/i.exec(v);
  if (mailto) return destinationOf(decodeURIComponent(mailto[1]!.split('?')[0]!));
  if (EMAIL.test(v)) return `email:${v.toLowerCase()}`;
  const compact = v.replace(/[\s-]/g, '').toUpperCase();
  if (IBAN.test(compact)) return `iban:${compact}`;
  if (/^https?:\/\//i.test(v)) {
    try { return `host:${host(new URL(v).hostname)}`; } catch { return `raw:${v}`; }
  }
  if (DOMAIN.test(v.toLowerCase())) return `host:${host(v)}`;
  const digits = v.replace(/[\s().-]/g, '');
  if (/^\+?\d{7,15}$/.test(digits)) return `phone:${digits.replace(/^\+/, '')}`;
  return `raw:${v}`;
}

/** Whether a whole value is shaped like a destination (an address, a link, an IBAN), whatever its field is called. */
function shaped(value: string): boolean {
  const d = destinationOf(value);
  return d.startsWith('email:') || d.startsWith('iban:') || (d.startsWith('host:') && /^(?:https?:\/\/|mailto:)/i.test(value.trim()));
}

/**
 * The destinations in one destination field: every address and every link in it ("Bob <bob@x.com>,
 * ann@y.org"; a link that carries an address carries both), else the value as one destination
 * (a domain, an IBAN, a number, or raw: never named). Past 20,000 characters it is raw.
 */
function inField(value: string): Destination[] {
  if (value.length > 20_000) return [`raw:${value.slice(0, 200)}`];
  const found = [
    ...[...value.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)].map((m) => destinationOf(m[0])),
    ...[...value.matchAll(/\b(?:https?|ftp|wss?):\/\/[^\s<>"',;]+/gi)].map((m) => destinationOf(m[0].replace(/^(?:ftp|wss?):/i, 'https:'))),
  ];
  return found.length ? found : [destinationOf(value)];
}

/**
 * Where a call sends data, from its input: every string under a destination field (to, recipient,
 * url, webhook, iban...), and every whole value shaped like an address, link or IBAN wherever it is.
 * Free text (a message body) is not scanned: what it mentions is content, not where it goes.
 */
export function callDestinations(input: unknown): Destination[] {
  const out = new Set<Destination>();
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 6) return;
    if (typeof v === 'string') {
      if (DEST_KEY.test(key) && v.trim()) for (const d of inField(v)) out.add(d);
      else if (v.length <= 2048 && shaped(v)) out.add(destinationOf(v));
    } else if (Array.isArray(v)) for (const x of v.slice(0, 200)) walk(x, key, depth + 1);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v).slice(0, 200)) walk(x, k, depth + 1);
  };
  walk(input, '', 0);
  return [...out];
}

/** The destinations a person's message names: addresses, links and bare domains, IBANs, phone numbers. */
export function namedDestinations(text: string): Destination[] {
  const out = new Set<Destination>();
  const t = text.slice(0, 100_000);
  for (const m of t.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) out.add(destinationOf(m[0]));
  for (const m of t.matchAll(/\bhttps?:\/\/[^\s<>"'()]+/gi)) out.add(destinationOf(m[0]));
  // A bare domain ("send it to the python.org docs"): not part of an address or a path, and not a file name ("notes.md").
  for (const m of t.matchAll(/(?<![@/\\\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,23}(?![\w@-])/gi)) {
    if (!FILE_EXT.test(m[0])) out.add(destinationOf(m[0]));
  }
  for (const m of t.matchAll(/\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/gi)) {
    const d = destinationOf(m[0]);
    if (d.startsWith('iban:')) out.add(d);
  }
  for (const m of t.matchAll(/(?<![\w.])\+?\d[\d\s().-]{6,18}\d(?!\w|\.\d)/g)) {
    const d = destinationOf(m[0]);
    if (d.startsWith('phone:')) out.add(d);
  }
  return [...out].filter((d) => !d.startsWith('raw:'));
}

/** Whether the person named this destination: exactly (an address, IBAN, phone), or a host they named or a subdomain of it. */
export function isNamed(d: Destination, named: ReadonlySet<Destination>): boolean {
  if (named.has(d)) return true;
  if (!d.startsWith('host:')) return false;
  const h = d.slice(5);
  for (const n of named) if (n.startsWith('host:') && h.endsWith(`.${n.slice(5)}`)) return true;
  return false;
}

/** How a destination reads to the person. */
export function showDestination(d: Destination): string {
  return d.replace(/^(?:email|host|iban|phone|raw):/, '').slice(0, 120);
}
