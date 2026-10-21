---
name: docker-hardening
description: Writing small, secure, reproducible container images - pinned bases, multi-stage builds, non-root users, no secrets in layers, healthchecks - and checking them with hadolint and trivy (the container tool), plus compose deploys with health checks and rollback. Use when writing or reviewing a Dockerfile or compose file.
---
# Docker hardening

## The container and deploy tools
- `container {"action": "lint", "dockerfile": "Dockerfile"}` - hadolint; errors and warnings fail the dockerfile-lint gate.
- `container {"action": "scan"}` - trivy fs: secrets and misconfigurations offline; vulnerabilities in lock files when trivy's database is there. `"mode": "config"` for IaC only; `"tarball"` for an image saved with docker save.
- `container {"action": "build", "tag": "app:1.2.3"}` needs a Docker daemon. A session sandbox has none: build then reports NOT BUILT and lints and scans instead. With `"dockerHost": "<Key Vault secret>"` it builds on that daemon and scans the image.
- `deploy {"action": "up", "project": "shop", "service": "web", "image": "shop-web:1.4.3", "healthUrl": "http://localhost:8080/health"}` - compose up, waits for healthy, checks the URL, and rolls back to the images that ran before if anything fails.

## A good Dockerfile
```dockerfile
# syntax=docker/dockerfile:1
FROM node:22.11-bookworm-slim AS build          # pinned tag (a digest for production: @sha256:...)
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci                                      # lock file, reproducible
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.11-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
USER node                                       # never run as root
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 CMD ["node", "dist/health.js"]
CMD ["node", "dist/server.js"]                  # exec form: signals reach the app
```
- **Pin the base** (a version tag, a digest for production) - hadolint DL3006/DL3007 flag untagged and :latest.
- **apt**: `apt-get update && apt-get install -y --no-install-recommends pkg=version && rm -rf /var/lib/apt/lists/*` in one RUN (DL3008, DL3009, DL3015). pip: `--no-cache-dir`, pinned versions (DL3013, DL3042).
- **Multi-stage**: compilers and dev dependencies stay in the build stage.
- **Non-root** `USER` (DL3002 flags a last USER of root); files owned by that user only where it writes.
- **No secrets in layers**: never `ENV`/`ARG` a password or token, never `COPY` a `.env` or key. Build secrets with `RUN --mount=type=secret,id=npmrc ...`. A `.dockerignore` with `.git`, `.env*`, `node_modules`, keys.
- **COPY over ADD** (DL3020) unless extracting a local tar; never `ADD https://...` without a checksum, never `curl | sh`.
- **Exec-form CMD/ENTRYPOINT** (DL3025) so SIGTERM reaches the process; `WORKDIR` instead of `cd` (DL3003).
- **Healthcheck**: in the image or in compose; compose's `up --wait` and the deploy tool rely on it.

## Compose for deploys
```yaml
services:
  web:
    image: shop-web:1.4.2                         # the deploy tool pins images through an override file
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    environment: { DATABASE_URL_FILE: /run/secrets/db_url }
    secrets: [db_url]
    healthcheck: { test: ["CMD", "node", "dist/health.js"], interval: 10s, timeout: 3s, retries: 3, start_period: 10s }
    deploy: { resources: { limits: { memory: 512m } } }
secrets:
  db_url: { file: ./secrets/db_url }               # not in git
```
- A healthcheck on every service the deploy should wait for; without one, "running" is all the deploy can check - add healthUrl.
- Tag images with versions or commit SHAs, never reuse a tag: rollback needs the previous image to still be what it was.

## Triage of scan findings
- CRITICAL/HIGH with a fix: update the base image or package. Without a fix: is the package reachable at runtime? Remove it if not (slim/distroless base), otherwise record an exception with a review date.
- Misconfigurations: fix them in the Dockerfile/compose/manifests; the iac-security gate blocks on HIGH/CRITICAL.
