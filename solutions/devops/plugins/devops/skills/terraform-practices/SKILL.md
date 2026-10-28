---
name: terraform-practices
description: Terraform / OpenTofu practice - module layout, providers and versions, state and backends, secrets, reading a plan (destroys, replacements, drift), safe refactors with moved blocks, and the iac tool's plan-then-approved-apply flow. Use before writing or changing .tf files or applying a plan.
---
# Terraform / OpenTofu practices

## The iac tool
- `iac {"action": "fmt", "write": true}` then `{"action": "validate"}` after every edit.
- `iac {"action": "plan", "dir": "infra"}` prints a summary by resource address (destroys first) and a **sha256**. Values are never shown.
- `iac {"action": "apply", "planHash": "<sha256>"}` applies exactly that plan file. The user approves the call; if the file changed after the plan, it is refused. A plan that destroys or replaces anything also needs `"allowDestroy": true`, which you pass only when the brief says destroys were approved.
- Credentials: `"env": {"AWS_ACCESS_KEY_ID": "cloud-aws-key-id", "AWS_SECRET_ACCESS_KEY": "cloud-aws-secret", "TF_VAR_db_password": "tf-db-password"}` names Key Vault secrets; apply reuses them. Never write a credential into a .tf or .tfvars file.
- The ops image (OpenTofu) has hashicorp/null, local and random built in; other providers need the network.

## Layout
- A root module per environment or stack (`envs/prod`, `envs/staging`) that calls shared modules (`modules/network`, `modules/service`). Root modules hold the backend, provider configuration and variable values; child modules never configure providers.
- Files: `main.tf`, `variables.tf` (every variable has a type and description; validation blocks for formats), `outputs.tf` (descriptions; `sensitive = true` for anything secret), `versions.tf`:
```hcl
terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}
```
- Pin provider versions with `~>` and commit `.terraform.lock.hcl`. Pin module sources to a tag or version.
- Name resources by role (`aws_s3_bucket.logs`), not by type (`aws_s3_bucket.bucket`). Use `for_each` over a map with stable keys rather than `count` over a list (removing an element of a list shifts every index after it - a destroy/create cascade).
- Tags/labels from one `locals` block (`owner`, `service`, `environment`).

## State
- Remote state with locking (S3 + DynamoDB lock or S3 native locking, GCS, azurerm, Terraform Cloud), encrypted, versioned, access limited. Never local state for shared infrastructure.
- State holds every secret value Terraform touched in plain text: **never** commit `terraform.tfstate*` (the secrets-in-repo gate fails on it), never print it, never paste it.
- One state per blast radius: networking, data, and services in separate states so a mistake in one cannot destroy another.
- Read other stacks through `terraform_remote_state` or data sources, not by copying IDs.

## Reading a plan (what review means)
1. Counts first: `N to add, N to change, N to destroy`. Any destroy needs a reason you can state.
2. **Replacements** (`-/+`, "replaced"): something forces a new resource - a changed name, AMI, subnet, an immutable argument. For stateful resources (databases, volumes, buckets) this is data loss. Avoid it: `lifecycle { prevent_destroy = true }` on stateful resources, `create_before_destroy` where a new copy must exist first, or change the argument differently.
3. Updates in place (`~`): check the attribute is the one you meant to change.
4. Drift ("changed outside this configuration"): someone changed the real thing. Decide - import the change into code, or let the apply revert it - and say which.
5. Outputs changing and data sources read (`<=`) are informational.

## Refactors without destroys
- Renaming or moving into a module: a `moved` block, not delete-and-recreate:
```hcl
moved {
  from = aws_instance.web
  to   = module.web.aws_instance.this
}
```
- Adopting an existing resource: an `import` block (`import { to = aws_s3_bucket.logs  id = "my-logs" }`), then plan shows no change.
- Removing from management without destroying: a `removed` block with `lifecycle { destroy = false }`.

## Drift
- A plan with `refresh` (the default) shows drift. A scheduled plan (no apply) that reports drift is the cheap way to watch for it.
- `terraform plan -refresh-only` to see what changed outside without proposing changes.

## Safety
- `tf-plan-no-destroy` blocks a run whose plan destroys unless the run allowed destroys.
- `iac-security` (trivy config) blocks on HIGH/CRITICAL: open security groups, public buckets, unencrypted storage, wildcard IAM.
- Small changes, one concern per plan. Apply the plan you reviewed - never re-plan and apply without review.
