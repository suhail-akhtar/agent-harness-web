// Where credentials come from. Every one is a Key Vault entry named int-*:
//  - a tool call reads them through its session's vault (ctx.services.vault),
//    after the vault permission rules decided the call (the tools declare the
//    names they read);
//  - background work (a chat button, a webhook, an incident event) has no
//    session: it reads them through the plugin's server-side vault (api.vault,
//    operator entries, when the harness provides one).
// Until a harness has either, the operator's declared secret
// HARNESS_INTEGRATIONS_SECRETS (a JSON object name -> value, or @<file>) stands in.
// Every value handed out is remembered so outputs can be redacted.

import fs from 'node:fs';

export class CredentialError extends Error {}

export class Credentials {
  constructor({ api, patterns = ['int-*'] }) {
    this.api = api;
    this.patterns = patterns;
    this.seen = new Set();
  }

  allowed(name) {
    return this.patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p));
  }

  fallback(name) {
    let raw;
    try { raw = this.api.secret?.('HARNESS_INTEGRATIONS_SECRETS'); } catch { raw = undefined; }
    if (!raw) return undefined;
    let obj;
    try { obj = JSON.parse(raw.startsWith('@') ? fs.readFileSync(raw.slice(1), 'utf8') : raw); } catch (e) { throw new CredentialError(`HARNESS_INTEGRATIONS_SECRETS could not be read as JSON (${e.code ?? 'parse error'})`); }
    const v = obj?.[name];
    return typeof v === 'string' && v ? v : undefined;
  }

  /**
   * One value. `vault` is a tool call's ctx.services.vault (absent for background work).
   * Never returned to the model: callers put it in a request header or body only.
   */
  async get(name, purpose, vault) {
    if (!this.allowed(name)) throw new CredentialError(`"${name}" is outside what the integrations plugin may read (permissions.vault: ${this.patterns.join(', ')})`);
    let value;
    const source = vault ?? this.api.vault;
    if (source && typeof source.reveal === 'function') {
      try { value = await source.reveal(name, purpose); } catch (e) {
        if (!/no (vault )?entry named|not found|no such entry/i.test(String(e.message))) throw new CredentialError(`the Key Vault did not give "${name}": ${e.message}`);
      }
    }
    if (value === undefined) value = this.fallback(name);
    if (typeof value !== 'string' || !value) throw new CredentialError(`credential "${name}" is not available: add it to the Key Vault (operator scope${vault ? ', allowed for this account' : ''})${this.api.vault || vault ? '' : ' - this harness gives the plugin no server-side vault, so set HARNESS_INTEGRATIONS_SECRETS'}`);
    this.seen.add(value);
    return value;
  }
}
