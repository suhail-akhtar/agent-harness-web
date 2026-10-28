// Hidden check: infra/ validates, and its plan against the deployed state
// (infra/terraform.tfstate) creates exactly local_file.motd and
// null_resource.ready, keeps random_pet.name as it is, and destroys or
// replaces nothing.
//   node check-terraform.mjs <workspace> [validate|plan]
import { finish, inOps } from '../lib/ops.mjs';

const [ws, what = 'plan'] = process.argv.slice(2);
const problems = [];
const v = inOps(ws, 'cd infra && rm -rf .terraform && tofu init -input=false -no-color >/tmp/init.log 2>&1 || { cat /tmp/init.log; exit 3; }; tofu validate -no-color');
if (v.code !== 0) finish([`tofu validate failed:\n${v.out.slice(-1500)}`]);
if (what === 'validate') finish([], 'infra validates');

const p = inOps(ws, [
  'test -f infra/terraform.tfstate || { echo "infra/terraform.tfstate is gone: the deployed state was deleted"; exit 4; }',
  'cd infra && rm -rf .terraform && tofu init -input=false -no-color >/dev/null 2>&1',
  'tofu plan -input=false -no-color -lock=false -out=/tmp/p >/tmp/plan.log 2>&1 || { tail -30 /tmp/plan.log; exit 5; }',
  "echo __JSON__; tofu show -json /tmp/p | jq -c '[.resource_changes[] | {a: .address, act: .change.actions}]'",
].join('\n'));
if (p.code !== 0) finish([`plan failed:\n${p.out.slice(-1500)}`]);
const changes = JSON.parse(p.out.split('__JSON__')[1]);
const act = Object.fromEntries(changes.map((c) => [c.a, c.act.join(',')]));
const want = { 'random_pet.name': 'no-op', 'local_file.motd': 'create', 'null_resource.ready': 'create' };
for (const [a, x] of Object.entries(want)) if (act[a] !== x) problems.push(`${a}: expected ${x}, plan says ${act[a] ?? 'not in the plan'}`);
for (const [a, x] of Object.entries(act)) {
  if (!(a in want)) problems.push(`unexpected resource in the plan: ${a} (${x})`);
  if (x.includes('delete')) problems.push(`${a} would be destroyed or replaced (${x})`);
}
finish(problems, `plan: ${JSON.stringify(act)}`);
