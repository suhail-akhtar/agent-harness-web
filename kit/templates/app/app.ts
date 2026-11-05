// npm start -- "your question"
import fs from 'node:fs';
import path from 'node:path';
import { startAgent } from './agent.ts';

const workspace = path.resolve('workspace');
fs.mkdirSync(workspace, { recursive: true });
const agent = await startAgent({ dataDir: path.resolve('data'), workspace, model: process.env.MODEL });
console.log(await agent.ask(process.argv.slice(2).join(' ') || 'What can you do?'));
console.log(`\n(cost: $${(agent.session.meta.cost ?? 0).toFixed(4)})`);
await agent.harness.close?.();
process.exit(0);
