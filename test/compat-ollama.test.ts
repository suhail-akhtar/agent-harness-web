import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import type { Block, HarnessEvent } from '../src/core/types.ts';
import { createHarness } from '../src/kernel/harness.ts';
import { dockerAvailable, imageExists } from '../src/runtime/docker.ts';
import { docker, freePort, removeContainer, waitForHttp } from './real-services.ts';
import { tempDir } from './helpers.ts';

// The OpenAI-compatible provider against a real server: Ollama in Docker with a
// small tool-capable model, driven through a whole harness session (the system
// prompt, every built-in tool, the agent loop). Free: the model runs locally.
//
// Runs when Docker has the ollama/ollama image (or HARNESS_TEST_OLLAMA=1, which
// pulls it: several GB). HARNESS_TEST_OLLAMA_URL uses a running server instead.
// The container and its model volume are removed afterwards; the image is kept.

const IMAGE = process.env.HARNESS_TEST_OLLAMA_IMAGE ?? 'ollama/ollama:latest';
const MODEL = process.env.HARNESS_TEST_OLLAMA_MODEL ?? 'qwen2.5:0.5b';
const external = process.env.HARNESS_TEST_OLLAMA_URL;
const enabled = !!external || ((await dockerAvailable()) && (process.env.HARNESS_TEST_OLLAMA === '1' || await imageExists(IMAGE)));

test(`compat provider against real Ollama (${MODEL}): a plain answer, then a read tool call the loop executes`, { skip: !enabled && `no Docker or ${IMAGE} (HARNESS_TEST_OLLAMA=1 pulls it)`, timeout: 1_800_000 }, async () => {
  const name = `hwtest-ollama-${process.pid}`;
  const volume = `${name}-models`;
  let base = external?.replace(/\/+$/, '');
  try {
    if (!base) {
      const port = await freePort();
      // The context the harness needs (system prompt and tool schemas) is larger than Ollama's default.
      const r = await docker(['run', '-d', '--name', name, '-v', `${volume}:/root/.ollama`, '-e', 'OLLAMA_CONTEXT_LENGTH=16384', '-p', `127.0.0.1:${port}:11434`, IMAGE], { timeoutMs: 900_000 });
      assert.equal(r.code, 0, r.stderr);
      base = `http://127.0.0.1:${port}`;
      await waitForHttp(`${base}/api/version`, 60_000, (s) => s === 200);
    }
    const pull = await fetch(`${base}/api/pull`, { method: 'POST', body: JSON.stringify({ model: MODEL, stream: false }), signal: AbortSignal.timeout(1_200_000) });
    const pulled = await pull.text();
    assert.equal(pull.status, 200, pulled);

    const ws = await tempDir();
    await fs.writeFile(path.join(ws, 'notes.txt'), 'The code word is MARIGOLD-42.\n');
    const before = process.env.HARNESS_MODELS_JSON;
    process.env.HARNESS_MODELS_JSON = JSON.stringify([{ id: 'ollama-small', label: `Ollama ${MODEL}`, preset: 'ollama', baseUrl: `${base}/v1`, model: MODEL, contextWindow: 16384, maxOutput: 1024, body: { temperature: 0, seed: 7 } }]);
    const h = await createHarness({ dataDir: await tempDir(), search: null, memory: 'off', scheduler: false });
    if (before === undefined) delete process.env.HARNESS_MODELS_JSON; else process.env.HARNESS_MODELS_JSON = before;
    try {
      assert.equal(h.registry.listModels().find((m) => m.id === 'ollama-small')?.available, true);
      const open = async () => {
        const s = await h.sessions.create({ model: 'ollama-small', mode: 'bypass', runtime: { kind: 'local', network: 'none', path: ws } });
        const events: HarnessEvent[] = [];
        s.subscribe(0, ({ event }) => { events.push(event); });
        const turn = async (text: string) => {
          const done = new Promise<void>((r) => s.subscribe(s.lastSeq, ({ event }) => { if (event.kind === 'turn_end' && !event.agent) r(); }));
          await s.send(text);
          await done;
        };
        return { s, events, turn };
      };
      let { s, events, turn } = await open();

      // 1. A plain answer: text streamed, usage reported by the server.
      await turn('Reply with one word: the colour of a clear daytime sky. Do not use any tools.');
      const answer = s.history.at(-1)!;
      assert.equal(answer.role, 'assistant');
      const text = answer.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      console.log(`# plain answer from ${MODEL}: ${JSON.stringify(text.slice(0, 200))}`);
      assert.ok(text.trim().length > 0, 'the model answered');
      assert.ok(events.some((e) => e.kind === 'text_delta'), 'the answer was streamed');
      const usage = events.find((e) => e.kind === 'usage') as Extract<HarnessEvent, { kind: 'usage' }> | undefined;
      assert.ok(usage && usage.usage.input + usage.usage.cacheRead > 1000, `real prompt tokens counted (${JSON.stringify(usage?.usage)})`);
      assert.equal(events.some((e) => e.kind === 'error'), false, JSON.stringify(events.filter((e) => e.kind === 'error')));

      // 2. A tool call: the model asks for read, the loop runs it, the result goes back.
      // A new session: a 0.5B model tends to repeat its previous answer.
      ({ s, events, turn } = await open());
      await turn('Use the read tool to open the file notes.txt, then tell me the code word written in it.');
      const blocks = s.history.flatMap((m) => m.content);
      const calls = blocks.filter((b) => b.type === 'tool_use' && b.name === 'read') as Extract<Block, { type: 'tool_use' }>[];
      console.log(`# read calls from ${MODEL}: ${JSON.stringify(calls.map((c) => c.input))}`);
      assert.ok(calls.length, `the model called read (history: ${JSON.stringify(blocks.map((b) => b.type === 'tool_use' ? `${b.name}(${JSON.stringify(b.input)})` : b.type))})`);
      const results = calls.map((c) => blocks.find((b) => b.type === 'tool_result' && b.tool_use_id === c.id) as Extract<Block, { type: 'tool_result' }> | undefined);
      assert.ok(results.every(Boolean), 'the loop answered every call');
      // A small model may first guess a wrong path; the loop reports it and the model tries again.
      assert.ok(results.some((r) => !r!.is_error && /MARIGOLD-42/.test(r!.content)), `the loop executed read on the file: ${JSON.stringify(results.map((r) => r!.content.slice(0, 200)))}`);
      const final = s.history.at(-1)!;
      assert.equal(final.role, 'assistant', 'the turn ended with the model answering after the result');
      const finalText = final.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
      console.log(`# answer after the tool: ${JSON.stringify(finalText.slice(0, 300))}`);
      if (!/MARIGOLD/i.test(finalText)) console.log('# (the small model did not repeat the code word; the call and its result are what this test checks)');
      assert.ok(s.meta.usage.output > 0);
    } finally {
      await h.close();
    }
  } finally {
    if (!external) await removeContainer(name, [volume]);
  }
});
