// A program of your own driving a harness server: the fourth way in docs/guide/04-build-your-system.md. It adds two
// claims in a conversation, starts the expense-review workflow, and approves it here, where your own interface would
// show the person the question. Needs a running server with the expense-review plugin:
//   HARNESS_URL=http://127.0.0.1:4310 HARNESS_TOKEN=... node review.ts
import { HarnessClient } from '@harness/client';

const base = process.env.HARNESS_URL ?? 'http://127.0.0.1:4310';
const token = process.env.HARNESS_TOKEN ?? '';
const model = process.env.MODEL ?? 'claude-haiku-5-5';
const client = new HarnessClient({ base, headers: () => ({ authorization: `Bearer ${token}` }) });

const session = await client.sessions.create({ model, mode: 'acceptEdits', runtime: 'local' });
const id = session.id;
console.log(`session ${id} on ${model}`);

let turnEnded = () => {};
let runEnded = () => {};
const stream = client.sessions.events(id, 0, (e) => {
  if (e.kind === 'tool_call') console.log(`  tool: ${e.name}`);
  // A tool that needs a person's yes. Here it is allowed; your interface would ask.
  if (e.kind === 'permission_request') void client.sessions.respond(id, { requestId: e.requestId, decision: 'allow' });
  // The workflow's approval step: this is where a person reads the decisions.
  if (e.kind === 'approval_request') {
    console.log(`\nApproval asked:\n${e.message}\n`);
    void client.sessions.respond(id, { requestId: e.requestId, decision: 'approve' });
  }
  if (e.kind === 'workflow' && e.phase === 'finished') runEnded();
  if (e.kind === 'turn_end' && (!e.agent || e.agent === 'main')) turnEnded();
});

const turn = (text: string) => new Promise<void>((resolve) => { turnEnded = resolve; void client.sessions.send(id, text); });

await turn('Add two expense claims: Ana spent 40 on a team lunch (category meals), and Tom spent 2000 on a flight to Oslo (category travel).');
await new Promise<void>((resolve) => { runEnded = resolve; void client.sessions.startWorkflow(id, 'expense-review', {}); });

const detail = await client.sessions.get(id);
console.log(`\ndone: $${(detail.meta?.cost ?? session.cost ?? 0).toFixed(4)}`);
stream.close?.();
process.exit(0);
