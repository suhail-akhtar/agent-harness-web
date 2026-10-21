// DevOps: infrastructure as code, Kubernetes, CI, containers and compose
// deploys, with the gates that judge them. Agents, skills and workflows live
// in their folders; this registers the tools and gates.
//
// Permission classes: planning, validating, linting and scanning run commands
// where the session's commands run (exec: free in a sandbox). Anything that
// changes a real system - apply, deploy, rollout undo, re-running or
// dispatching CI - is external and always asked. Anything that talks to a
// remote API (a cluster, GitHub, a Docker host) can carry data out (sendsOut).
// Credentials come from the Key Vault (ctx.services.vault) into the command's
// stdin, never into the workspace, the command line or the output.

import { defineTool } from '../../src/plugins/api.ts';
import { opsAvailable } from './lib/common.mjs';
import { CI_CHANGES, CI_REMOTE, ciParameters, runCi } from './lib/ci.mjs';
import { containerParameters, runContainer } from './lib/container.mjs';
import { DEPLOY_CHANGES, deployParameters, runDeploy } from './lib/deploy.mjs';
import { gates, secretsGate } from './lib/gates.mjs';
import { describeApply, iacParameters, runIac } from './lib/iac.mjs';
import { K8S_CHANGES, K8S_REMOTE, k8sParameters, runK8s } from './lib/k8s.mjs';

const act = (i) => String(i.action ?? '');

export function tools(api) {
  return [
    defineTool({
      name: 'iac',
      description: 'Terraform / OpenTofu in a module directory. fmt (check, or write), validate (every root module without dir), plan (summarised: adds, changes, destroys per resource address, destroys first; values are never shown; writes a plan file and prints its sha256), apply (ONLY a plan this tool made, by its sha256 - the file must be unchanged; the user approves it; plans that destroy need allowDestroy). Cloud credentials come from the Key Vault with env {"AWS_ACCESS_KEY_ID": "<secret name>"}. State is never printed. Load the terraform-practices skill first.',
      parameters: iacParameters,
      kind: 'exec',
      kindsFor: (i) => (act(i) === 'apply' ? ['exec', 'external'] : ['exec']),
      sendsOut: (i) => act(i) === 'plan' || act(i) === 'apply',
      availableIn: opsAvailable,
      summarize: (i) => (act(i) === 'apply' ? describeApply(i) : `${act(i)} ${i.dir ?? '.'}${i.env && Object.keys(i.env).length ? ` with vault ${Object.values(i.env).join(',')}` : ''}`),
      run: (input, ctx) => runIac(input, ctx),
    }),
    defineTool({
      name: 'k8s',
      description: 'Kubernetes. Offline: validate (kubeconform strict against cached schemas; every manifest and chart in the workspace by default), template (helm template, then validated), lint (helm lint). Against a cluster: diff, apply (waits for changed workloads to roll out and shows why pods fail), rollout-status, rollout-undo, get, describe, logs, events - summarised. The kubeconfig comes from the Key Vault ("kubeconfig": "<secret name>") into a temporary file for the call. Load the kubernetes-operations skill first.',
      parameters: k8sParameters,
      kind: 'exec',
      kindsFor: (i) => (K8S_CHANGES.has(act(i)) ? ['exec', 'external'] : ['exec']),
      sendsOut: (i) => K8S_REMOTE.has(act(i)),
      availableIn: opsAvailable,
      summarize: (i) => `${act(i)} ${i.resource ?? (Array.isArray(i.paths) ? i.paths.join(' ') : i.chart ?? '')}${i.namespace ? ` -n ${i.namespace}` : ''}${i.context ? ` --context ${i.context}` : ''}${i.kubeconfig ? ` (kubeconfig ${i.kubeconfig})` : ''}`.trim(),
      run: (input, ctx) => runK8s(input, ctx),
    }),
    defineTool({
      name: 'ci',
      description: 'GitHub Actions. runs (newest first; filter by workflow, branch, status), jobs (a run\'s jobs and failing steps), logs (the failing jobs\' logs trimmed to the error), watch (wait for a run - by runId, or the newest on a branch/sha - to finish), rerun-failed, dispatch (workflow_dispatch), lint (actionlint on workflow files), run-local (run a job\'s run: steps here, the way CI would, to reproduce a failure before pushing). The repo defaults to the workspace\'s origin; the token comes from the Key Vault (github-token) or the server. Load the ci-debugging skill first.',
      parameters: ciParameters,
      kind: 'exec',
      kindsFor: (i) => (CI_CHANGES.has(act(i)) ? ['external'] : CI_REMOTE.has(act(i)) ? ['network'] : ['exec']),
      sendsOut: (i) => CI_REMOTE.has(act(i)),
      summarize: (i) => `${act(i)}${i.repo ? ` ${i.repo}` : ''}${i.workflow ? ` ${i.workflow}` : ''}${i.runId ? ` run ${i.runId}` : ''}${i.jobId ? ` job ${i.jobId}` : ''}${i.branch ? ` on ${i.branch}` : ''}${i.ref ? ` at ${i.ref}` : ''}`,
      run: (input, ctx) => runCi(input, ctx, api),
    }),
    defineTool({
      name: 'container',
      description: 'Containers. lint (hadolint on a Dockerfile), scan (trivy: fs - secrets, misconfigurations and, with its database, vulnerabilities; config - IaC only; tarball - an image from docker save), build (needs a Docker daemon: a session sandbox has none, so build says NOT BUILT and lints and scans the Dockerfile instead; pass dockerHost, a Key Vault secret with a DOCKER_HOST, to build there). Findings by severity. Load the docker-hardening skill first.',
      parameters: containerParameters,
      kind: 'exec',
      kindsFor: (i) => (act(i) === 'build' && i.dockerHost ? ['exec', 'external'] : ['exec']),
      sendsOut: (i) => act(i) === 'build' && !!i.dockerHost,
      availableIn: opsAvailable,
      summarize: (i) => `${act(i)} ${i.tag ?? i.tarball ?? i.dockerfile ?? i.path ?? ''}${i.dockerHost ? ` on ${i.dockerHost}` : ''}`.trim(),
      run: (input, ctx) => runContainer(input, ctx),
    }),
    defineTool({
      name: 'deploy',
      description: 'Docker Compose deploys to a target: the Docker daemon where commands run, or a DOCKER_HOST (tcp:// or ssh://) from the Key Vault. ps; up (optionally a new image for one service), then health is verified (every service running and healthy, plus healthUrl or healthCmd) and on failure it rolls back to the images that ran before automatically; down; rollback (to the last healthy deploy). History in .harness/devops/deploy/.',
      parameters: deployParameters,
      kind: 'exec',
      kindsFor: (i) => (DEPLOY_CHANGES.has(act(i)) ? ['exec', 'external'] : ['exec']),
      sendsOut: (i) => !!i.dockerHost || DEPLOY_CHANGES.has(act(i)),
      availableIn: opsAvailable,
      summarize: (i) => `${act(i)} ${i.project ?? '?'}${i.service ? ` ${i.service}=${i.image ?? '?'}` : ''}${i.dockerHost ? ` on ${i.dockerHost}` : ' (local daemon)'}`,
      run: (input, ctx) => runDeploy(input, ctx),
    }),
  ];
}

export default {
  name: 'devops',
  async setup(api) {
    for (const t of tools(api)) api.registerTool(t);
    for (const g of gates) api.registerGate(g);
    api.registerGate(await secretsGate());
    api.log(`5 tools, ${gates.length + 1} gates`);
  },
};
