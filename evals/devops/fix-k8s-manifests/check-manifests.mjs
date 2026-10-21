// Hidden checks for fix-k8s-manifests, in the ops image:
//   node check-manifests.mjs <workspace> schema   kubeconform (strict) on k8s/
//   node check-manifests.mjs <workspace> policy   the team's policy (below)
import { finish, inOps } from '../lib/ops.mjs';

const [ws, what = 'policy'] = process.argv.slice(2);

if (what === 'schema') {
  const r = inOps(ws, 'kubeconform -strict -summary -schema-location "$HARNESS_K8S_SCHEMAS/{{ .NormalizedKubernetesVersion }}-standalone{{ .StrictSuffix }}/{{ .ResourceKind }}{{ .KindSuffix }}.json" k8s/*.yaml');
  finish(r.code === 0 ? [] : [`kubeconform: ${r.out.slice(-1500)}`], r.out.trim().split('\n').pop());
}

// The policy: one Deployment web and one Service web in namespace shop; >= 2
// replicas; every container with a pinned image (not :latest), CPU and memory
// requests and limits, readiness and liveness probes on the container's port,
// runAsNonRoot, no privilege escalation, a read-only root filesystem; the
// Service selects the Deployment's pods and targets a port the container has.
const POLICY = String.raw`
import glob, json, sys, yaml
docs = [d for f in sorted(glob.glob('k8s/*.yaml')) for d in yaml.safe_load_all(open(f)) if d]
p = []
deps = [d for d in docs if d.get('kind') == 'Deployment']
svcs = [d for d in docs if d.get('kind') == 'Service']
if [d['metadata'].get('name') for d in deps] != ['web']: p.append('expected exactly one Deployment named web')
if [d['metadata'].get('name') for d in svcs] != ['web']: p.append('expected exactly one Service named web')
for d in deps + svcs:
    if d['metadata'].get('namespace') != 'shop': p.append('%s %s is not in namespace shop' % (d['kind'], d['metadata'].get('name')))
for d in deps:
    spec = d.get('spec') or {}
    if not isinstance(spec.get('replicas'), int) or spec['replicas'] < 2: p.append('replicas must be a number >= 2')
    tpl = (spec.get('template') or {})
    pod = tpl.get('spec') or {}
    labels = (tpl.get('metadata') or {}).get('labels') or {}
    psc = pod.get('securityContext') or {}
    for c in pod.get('containers') or []:
        n = c.get('name')
        img = str(c.get('image', ''))
        tag = img.rsplit('/', 1)[-1]
        if '@sha256:' not in img and (':' not in tag or tag.endswith(':latest')): p.append('%s: image %s is not pinned to a version' % (n, img))
        res = c.get('resources') or {}
        for k in ('requests', 'limits'):
            for r in ('cpu', 'memory'):
                if r not in (res.get(k) or {}): p.append('%s: resources.%s.%s missing' % (n, k, r))
        ports = {pp.get('containerPort') for pp in c.get('ports') or []} | {pp.get('name') for pp in c.get('ports') or []}
        for probe in ('readinessProbe', 'livenessProbe'):
            pr = c.get(probe)
            if not pr: p.append('%s: %s missing' % (n, probe)); continue
            port = (pr.get('httpGet') or pr.get('tcpSocket') or {}).get('port')
            if port is not None and port not in ports: p.append('%s: %s port %s is not a container port' % (n, probe, port))
        csc = c.get('securityContext') or {}
        if not (csc.get('runAsNonRoot') or psc.get('runAsNonRoot')): p.append('%s: runAsNonRoot is not set' % n)
        if csc.get('allowPrivilegeEscalation') is not False: p.append('%s: allowPrivilegeEscalation must be false' % n)
        if csc.get('readOnlyRootFilesystem') is not True: p.append('%s: readOnlyRootFilesystem must be true' % n)
        if csc.get('privileged'): p.append('%s: privileged' % n)
    for s in svcs:
        sel = (s.get('spec') or {}).get('selector') or {}
        if not sel or any(labels.get(k) != v for k, v in sel.items()): p.append('Service %s selector %s does not match the pods %s' % (s['metadata'].get('name'), sel, labels))
        allports = set()
        for c in pod.get('containers') or []:
            allports |= {pp.get('containerPort') for pp in c.get('ports') or []} | {pp.get('name') for pp in c.get('ports') or []}
        for sp in (s.get('spec') or {}).get('ports') or []:
            if sp.get('targetPort', sp.get('port')) not in allports: p.append('Service port %s targets %s, which no container has' % (sp.get('port'), sp.get('targetPort')))
print(json.dumps(p))
`;
const r = inOps(ws, `python3 - <<'HW_POLICY'\n${POLICY}\nHW_POLICY`);
let problems;
try { problems = JSON.parse(r.out.trim().split('\n').pop()); } catch { problems = [`the policy check could not run: ${r.out.slice(-800)}`]; }
finish(problems, 'policy holds');
