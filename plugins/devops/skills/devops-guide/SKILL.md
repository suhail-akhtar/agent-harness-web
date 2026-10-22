---
name: devops-guide
description: DevOps: Terraform, Kubernetes, GitHub Actions, containers and compose deploys, with gates and approvals.
---

# DevOps (devops)

## What it is for

Changing infrastructure and delivery safely: plan before apply, validate before rollout, read a
failing pipeline's logs and reproduce it, lint and scan images, deploy with health checks and
automatic rollback. Use it when the person mentions Terraform, a Kubernetes manifest or rollout,
CI (GitHub Actions), a Dockerfile, an image, or a deploy.

## Tools (they run in the ops sandbox image; credentials come from the Key Vault)

- `iac`: fmt, validate, plan (summarised adds, changes, destroys), apply of an approved plan only.
- `k8s`: validate (kubeconform), template (helm), diff, apply, rollout status, undo.
- `ci`: GitHub Actions runs, jobs, failing logs trimmed to the error, re-run, reproduce locally.
- `container`: lint (hadolint), scan (trivy), build.
- `deploy`: Docker Compose to a target: ps, up with health checks and automatic rollback, down.

Changes (apply, rollout, deploy, re-run) are asked about; read-only steps are not.

## Workflows, agents, gates

- Workflows: `ship-change` (plan -> approve -> apply -> verify), `pipeline-fix` (failing CI ->
  cause -> fix -> green), `k8s-rollout` (validate -> diff -> apply -> watch -> undo on failure).
- Agents: platform-engineer, release-manager, security-reviewer-iac.
- Gates: terraform-valid, tf-plan-no-destroy, k8s-manifests-valid, dockerfile-lint, shell-lint,
  workflow-lint, iac-security, secrets-in-repo (run with `quality_gates`).
- Skills: terraform-practices, kubernetes-operations, ci-debugging, docker-hardening.

## Worked examples

**"Why is CI red?"**: `ci {"action":"runs"}` -> the failing run's `jobs` -> `logs`; find the cause,
reproduce locally if you can, fix, push only when the person asks.

**"Apply the Terraform change"**: `iac` fmt and validate, `plan`, show the summary (destroys first),
wait for approval, then apply that plan; run `tf-plan-no-destroy` when destroys are unexpected.

**"Roll out the new image to staging"**: the `k8s-rollout` workflow, or `k8s` validate -> diff ->
apply (asked) -> rollout status; undo if it does not become healthy.

There is no page for DevOps in the app: results show in the conversation; incidents and changes
show on the Operations pages (aiops) when that plugin is on.
<!-- generated -->
