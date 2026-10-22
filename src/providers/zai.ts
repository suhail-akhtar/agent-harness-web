import type { Effort } from '../core/models.ts';
import type { Provider, ProviderRequest, ProviderResponse } from './types.ts';
import { ProviderError } from './types.ts';
import { postStream } from './http.ts';
import { errorBody, finishTurn, readChatStream, toReasoningChat } from './chat-shared.ts';

// Z.ai's GLM models (glm-5.3-flash) over the general API's OpenAI-compatible
// Chat Completions endpoint, https://api.z.ai/api/paas/v4.
//
// Why Chat Completions and not the Anthropic-compatible /api/anthropic: the
// GLM controls an agent needs are documented there - thinking.clear_thinking
// (Preserved Thinking), reasoning_effort, tool_stream - and it is the endpoint
// pay-as-you-go keys are billed on. ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
// uses a GLM Coding Plan's quota instead (same protocol).
// Sources (checked 2026-10-22):
//   https://docs.z.ai/api-reference/introduction          base URL, auth
//   https://docs.z.ai/api-reference/llm/chat-completion   request, finish reasons, usage
//   https://docs.z.ai/guides/vlm/glm-5.3-flash            recommended settings, limits
//   https://docs.z.ai/guides/capabilities/thinking-mode   interleaved/preserved thinking
//   https://docs.z.ai/guides/capabilities/cache           implicit caching, cached_tokens
//   https://docs.z.ai/api-reference/api-code              error codes
//   https://docs.z.ai/devpack/notice/api-key-management   general vs Coding Plan endpoints
//
// Thinking is forced on GLM-5.3-Flash; reasoning_effort (low | high | max) sets
// its depth. clear_thinking: false keeps earlier turns' reasoning in the prompt
// (Preserved Thinking, which Z.ai recommends for agents and says raises cache
// hits); the reasoning_content of every assistant turn is replayed unmodified,
// as interleaved thinking with tools requires. Caching is implicit: no
// parameters, cached tokens reported in usage.prompt_tokens_details.

const DEFAULT_BASE = 'https://api.z.ai/api/paas/v4';
/** "A max of 128 functions are supported." */
const MAX_TOOLS = 128;

export function glmEffort(e: Effort): 'low' | 'high' | 'max' {
  return e === 'low' ? 'low' : e === 'xhigh' || e === 'max' ? 'max' : 'high';
}

/** The request body. Exported for tests: the cache depends on its exact shape. */
export function zaiBody(req: Pick<ProviderRequest, 'model' | 'system' | 'tools' | 'messages' | 'effort'>): Record<string, unknown> {
  const messages: unknown[] = [{ role: 'system', content: req.system }];
  // Tool messages are text only on Z.ai: a result's images follow it as user content.
  for (const m of req.messages) messages.push(...toReasoningChat(m, { provider: 'zai', toolImages: 'split' }));
  const body: Record<string, unknown> = { model: req.model.id, messages };
  if (req.tools.length) {
    if (req.tools.length > MAX_TOOLS) throw new ProviderError(`Z.ai (${req.model.id}) accepts at most ${MAX_TOOLS} tools; this session has ${req.tools.length}. Turn off some plugins or MCP servers for it.`, 400, false);
    body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
    body.tool_choice = 'auto'; // the only value Z.ai accepts
    body.tool_stream = true; // tool-call arguments stream as they are generated
  }
  body.stream = true; // usage comes with the last chunk; Z.ai documents no stream_options
  body.max_tokens = req.model.maxOutput;
  body.thinking = { type: 'enabled', clear_thinking: false };
  body.reasoning_effort = glmEffort(req.effort);
  return body;
}

export class ZaiProvider implements Provider {
  private apiKey: string;
  readonly baseUrl: string;
  constructor(apiKey: string, baseUrl = process.env.ZAI_BASE_URL || DEFAULT_BASE) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async send(req: ProviderRequest): Promise<ProviderResponse> {
    const body = zaiBody(req);
    let res: Response;
    try {
      // Accept-Language: error messages in English.
      res = await postStream(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.apiKey}`, 'accept-language': 'en-US,en' }, body, req.signal);
    } catch (err) {
      if (!(err instanceof ProviderError) || req.signal.aborted) throw err;
      throw zaiError(err.status, errorBody(err), err.retryAfterMs, req.model.id, this.baseUrl);
    }
    const turn = await readChatStream(res, req, (e) => zaiError(0, { code: e.code !== undefined ? String(e.code) : undefined, message: e.message ?? 'stream error' }, undefined, req.model.id, this.baseUrl));
    // A stream that fails during inference reports it as a finish reason, not an error code.
    if (turn.finish === 'network_error') throw new ProviderError(`Z.ai (${req.model.id}): the stream ended with finish_reason network_error`, 500, true);
    const r = finishTurn(turn, req.model.id, 'zai', body);
    if (turn.finish === 'sensitive') return { ...r, stop: 'refusal', notice: 'Z.ai stopped this response: content review flagged the input or output (finish_reason "sensitive").' };
    if (turn.finish === 'model_context_window_exceeded') return { ...r, stop: 'max_tokens', notice: 'Z.ai stopped this response: the context window is full (finish_reason "model_context_window_exceeded"). Compact the session.' };
    return r;
  }
}

/** Z.ai business codes to retryable or not, with what to do. https://docs.z.ai/api-reference/api-code */
export function zaiError(status: number, e: { code?: string; message: string }, retryAfterMs: number | undefined, model: string, baseUrl = DEFAULT_BASE): ProviderError {
  const msg = e.message.slice(0, 600);
  const where = `Z.ai (${model})`;
  const code = Number(e.code);
  const st = status || 500;
  switch (code) {
    case 1113:
      return new ProviderError(`${where}: insufficient balance or no resource package (code 1113) - ${msg}. Top up the Z.ai account balance (retrying will not help).`, st, false);
    case 1302:
      return new ProviderError(`${where}: rate limited (code 1302) - ${msg}`, st, true, retryAfterMs);
    case 1305:
      return new ProviderError(`${where}: overloaded (code 1305) - ${msg}`, st, true, retryAfterMs);
    case 1234:
    case 1200:
    case 1230:
      return new ProviderError(`${where}: server error (code ${code}) - ${msg}`, st, true, retryAfterMs);
    case 1261:
      return new ProviderError(`${where}: the prompt is longer than the model's context window (code 1261) - ${msg}. Compact the session (or lower HARNESS_COMPACT_AT).`, st, false);
    case 1301:
      return new ProviderError(`${where}: refused by content review (code 1301) - ${msg}`, st, false);
    case 1000: case 1001: case 1003: case 1005:
      return new ProviderError(`${where}: the key was refused (code ${code}) - ${msg}. Check ZAI_API_KEY; a GLM Coding Plan key needs ZAI_BASE_URL=https://api.z.ai/api/coding/paas/v4, a BigModel (China) key https://open.bigmodel.cn/api/paas/v4 (now ${baseUrl}).`, st, false);
    case 1211:
      return new ProviderError(`${where}: unknown model (code 1211) - ${msg}`, st, false);
  }
  // Plan and package limits (1308-1321): they reset at a stated time, not in seconds.
  if (code >= 1308 && code <= 1321) return new ProviderError(`${where}: usage limit or plan restriction (code ${code}) - ${msg}`, st, false);
  if (code >= 1210 && code <= 1222) return new ProviderError(`${where}: invalid request (code ${code}) - ${msg}`, st, false);
  if (status === 401 || status === 403) return new ProviderError(`${where}: the key was refused (${status}) - ${msg}. Check ZAI_API_KEY.`, status, false);
  if (status === 0) return new ProviderError(`${where}: ${msg}`, 500, true);
  return new ProviderError(`${where}: ${status} ${msg}`, status, status === 408 || status === 409 || status === 429 || status >= 500, retryAfterMs);
}
