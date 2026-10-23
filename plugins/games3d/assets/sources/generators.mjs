// Generator providers: images through OpenAI's image API (textures, concept art, sprites),
// and text-to-3D through Meshy and Tripo3D. Paid: every call is costed and recorded in a
// spend ledger outside the workspace, and refused before it is made when it would cross
// the cap (per workspace and per project; default USD 0.50 each, HARNESS_STUDIO_IMAGE_BUDGET).

import fsp from 'node:fs/promises';
import path from 'node:path';

// ---------- the spend ledger ----------

/** USD per million tokens. gpt-image-1: text in 5, image in 10, image out 40 (OpenAI's price list). */
export const IMAGE_PRICES = {
  'gpt-image-1': { text: 5, imageIn: 10, out: 40 },
  'gpt-image-1-mini': { text: 2, imageIn: 2.5, out: 8 },
};
/** Output tokens an image costs, by quality and size (OpenAI's tables for gpt-image-1). */
export const IMAGE_OUT_TOKENS = {
  low: { '1024x1024': 272, '1024x1536': 408, '1536x1024': 400 },
  medium: { '1024x1024': 1056, '1024x1536': 1584, '1536x1024': 1568 },
  high: { '1024x1024': 4160, '1024x1536': 6240, '1536x1024': 6208 },
};

export function pricesFor(model) {
  let extra = {};
  try { extra = JSON.parse(process.env.HARNESS_STUDIO_IMAGE_PRICES || '{}'); } catch { /* ignored: bad JSON */ }
  return extra[model] ?? IMAGE_PRICES[model] ?? null;
}

/** The cost before a call: output tokens by table, the prompt at about 4 characters a token. */
export function estimateImageUsd({ model = 'gpt-image-1', quality = 'low', size = '1024x1024', prompt = '' }) {
  const p = pricesFor(model);
  if (!p) return null;
  const q = IMAGE_OUT_TOKENS[quality === 'auto' ? 'medium' : quality] ?? IMAGE_OUT_TOKENS.medium;
  const out = q[size] ?? Math.max(...Object.values(q));
  return (out * p.out + Math.ceil(String(prompt).length / 4) * p.text) / 1e6;
}

/** The cost after a call, from the usage the API returned. */
export function costFromUsage(model, usage) {
  const p = pricesFor(model);
  if (!p || !usage) return null;
  const text = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
  const img = usage.input_tokens_details?.image_tokens ?? 0;
  return (text * p.text + img * p.imageIn + (usage.output_tokens ?? 0) * p.out) / 1e6;
}

export const budgets = () => ({
  workspace: Number(process.env.HARNESS_STUDIO_IMAGE_BUDGET_SESSION ?? process.env.HARNESS_STUDIO_IMAGE_BUDGET ?? 0.5),
  project: Number(process.env.HARNESS_STUDIO_IMAGE_BUDGET ?? 0.5),
  total: process.env.HARNESS_STUDIO_IMAGE_BUDGET_TOTAL ? Number(process.env.HARNESS_STUDIO_IMAGE_BUDGET_TOTAL) : Infinity,
  tasks3d: Number(process.env.HARNESS_STUDIO_3D_TASKS ?? 3),
});

/** The ledger in the plugin's data folder (no agent can edit it): every paid call. */
export class SpendLedger {
  constructor(dir) { this.file = path.join(dir, 'studio-spend.json'); }
  async entries() { try { return JSON.parse(await fsp.readFile(this.file, 'utf8')).entries ?? []; } catch { return []; } }
  async add(e) {
    const all = await this.entries();
    all.push({ ...e, at: new Date().toISOString() });
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await fsp.writeFile(this.file, JSON.stringify({ entries: all }, null, 1));
  }
  /** What has been spent: in this workspace, this project, in all. */
  async spent(workspace, project) {
    const all = await this.entries();
    const sum = (f) => all.filter(f).reduce((s, e) => s + (e.usd ?? 0), 0);
    return { workspace: sum((e) => e.workspace === workspace), project: sum((e) => e.workspace === workspace && e.project === project), total: sum(() => true), tasks3d: all.filter((e) => e.workspace === workspace && e.kind === 'text3d').length };
  }
  /** Throws when a call of `usd` would cross a cap. */
  async check(workspace, project, usd) {
    const s = await this.spent(workspace, project), b = budgets();
    for (const [k, label] of [['workspace', 'this session\'s workspace'], ['project', 'this project'], ['total', 'all projects']]) {
      if (s[k] + usd > b[k] + 1e-9) throw new Error(`image generation refused: it would cost about USD ${usd.toFixed(4)} and ${label} has spent USD ${s[k].toFixed(4)} of its USD ${b[k].toFixed(2)} cap (HARNESS_STUDIO_IMAGE_BUDGET${k === 'total' ? '_TOTAL' : k === 'workspace' ? '_SESSION' : ''} raises it; the operator sets it). Make it procedurally instead (studio_sprite, studio_image), or ask the person.`);
    }
    return s;
  }
}

// ---------- OpenAI images ----------

/**
 * One image: { png, usage, usd, revisedPrompt }. background "transparent" asks for alpha
 * (sprites); quality low|medium|high; size 1024x1024|1024x1536|1536x1024.
 */
export async function openaiImage(fetch, key, { prompt, model = 'gpt-image-1', size = '1024x1024', quality = 'low', background = 'auto' }) {
  if (!key) throw new Error('OPENAI_API_KEY is not set on the server');
  const r = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt, size, quality, background, n: 1, output_format: 'png' }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI images answered ${r.status}: ${body.error?.message ?? JSON.stringify(body).slice(0, 300)}`);
  const d = body.data?.[0];
  if (!d?.b64_json) throw new Error('OpenAI returned no image data');
  return { png: Buffer.from(d.b64_json, 'base64'), usage: body.usage ?? null, usd: costFromUsage(model, body.usage), revisedPrompt: d.revised_prompt };
}

// ---------- text to 3D ----------

const sleep = (ms, signal) => new Promise((res, rej) => { const t = setTimeout(res, ms); signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('cancelled')); }, { once: true }); });

/** Meshy (api.meshy.ai, v2 text-to-3d): a preview mesh task, then optionally a textured refine. */
export const meshy = {
  id: 'meshy', secret: 'MESHY_API_KEY', hosts: ['api.meshy.ai', 'assets.meshy.ai'],
  license: { id: 'LicenseRef-Meshy-Terms', author: 'generated with Meshy', url: 'https://www.meshy.ai/terms-of-use' },
  async start(fetch, key, { prompt, artStyle = 'realistic', topology = 'triangle', targetPolycount = 10000, refineOf, texturePrompt } = {}) {
    const body = refineOf ? { mode: 'refine', preview_task_id: refineOf, enable_pbr: true, ...(texturePrompt ? { texture_prompt: texturePrompt } : {}) } : { mode: 'preview', prompt, art_style: artStyle, should_remesh: true, topology, target_polycount: targetPolycount };
    const r = await fetch('https://api.meshy.ai/openapi/v2/text-to-3d', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.result) throw new Error(`Meshy answered ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 300)}`);
    return j.result;
  },
  async poll(fetch, key, id) {
    const r = await fetch(`https://api.meshy.ai/openapi/v2/text-to-3d/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Meshy answered ${r.status}: ${j.message ?? ''}`);
    const status = { SUCCEEDED: 'done', FAILED: 'failed', CANCELED: 'failed', EXPIRED: 'failed' }[j.status] ?? 'running';
    return { status, progress: j.progress ?? 0, modelUrl: j.model_urls?.glb, thumbnail: j.thumbnail_url, error: j.task_error?.message };
  },
};

/** Tripo3D (api.tripo3d.ai v2): a text_to_model task. */
export const tripo = {
  id: 'tripo', secret: 'TRIPO_API_KEY', hosts: ['api.tripo3d.ai', '*.tripo3d.ai', '*.tripo3d.com'],
  license: { id: 'LicenseRef-Tripo-Terms', author: 'generated with Tripo3D', url: 'https://www.tripo3d.ai/terms' },
  async start(fetch, key, { prompt, faceLimit = 10000, texture = true, pbr = true, modelVersion } = {}) {
    const r = await fetch('https://api.tripo3d.ai/v2/openapi/task', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'text_to_model', prompt, face_limit: faceLimit, texture, pbr, ...(modelVersion ? { model_version: modelVersion } : {}) }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 0 || !j.data?.task_id) throw new Error(`Tripo answered ${r.status}: ${j.message ?? JSON.stringify(j).slice(0, 300)}`);
    return j.data.task_id;
  },
  async poll(fetch, key, id) {
    const r = await fetch(`https://api.tripo3d.ai/v2/openapi/task/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${key}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 0) throw new Error(`Tripo answered ${r.status}: ${j.message ?? ''}`);
    const d = j.data ?? {};
    const status = d.status === 'success' ? 'done' : ['failed', 'cancelled', 'banned', 'expired', 'unknown'].includes(d.status) ? 'failed' : 'running';
    return { status, progress: d.progress ?? 0, modelUrl: d.output?.pbr_model ?? d.output?.model ?? d.output?.base_model, thumbnail: d.output?.rendered_image, error: status === 'failed' ? `task ${d.status}` : undefined };
  },
};

export const TEXT3D = { meshy, tripo };

/** Polls a task until it is done or failed (or waitSec passes): its last state. */
export async function waitTask(provider, fetch, key, id, { waitSec = 600, everyMs = 5000, signal } = {}) {
  const until = Date.now() + waitSec * 1000;
  for (;;) {
    const s = await provider.poll(fetch, key, id);
    if (s.status !== 'running' || Date.now() + everyMs > until) return s;
    await sleep(everyMs, signal);
  }
}
