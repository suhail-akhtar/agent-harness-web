---
name: kubernetes-operations
description: Kubernetes in practice - manifests that validate and run well (resources, probes, security context, pinned images), Helm, rollouts and undo, and debugging CrashLoopBackOff, ImagePullBackOff, Pending and not-ready pods with the k8s tool. Use before writing manifests or touching a cluster.
---
# Kubernetes operations

## The k8s tool
- Offline (no cluster): `{"action": "validate"}` (kubeconform strict: an unknown or misspelt field is an error), `{"action": "template", "chart": "charts/web", "values": ["values-prod.yaml"]}`, `{"action": "lint", "chart": "charts/web"}`.
- Cluster: pass `"kubeconfig": "<Key Vault secret>"` (and `context`, `namespace`). `diff` before `apply`; `apply` waits for the rollouts it caused and shows failing pods; `rollout-status`, `rollout-undo`, `get`, `describe`, `logs` (`previous: true` for the crashed container), `events`.
- apply and rollout-undo are asked; everything else only reads.

## A workload that behaves
```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: web, labels: { app: web } }
spec:
  replicas: 2
  revisionHistoryLimit: 5
  strategy: { type: RollingUpdate, rollingUpdate: { maxUnavailable: 0, maxSurge: 1 } }
  selector: { matchLabels: { app: web } }
  template:
    metadata: { labels: { app: web } }
    spec:
      automountServiceAccountToken: false
      securityContext: { runAsNonRoot: true, runAsUser: 10001, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: web
          image: registry.example.com/web:1.4.2      # pinned, never :latest
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 100m, memory: 128Mi }
            limits: { memory: 256Mi }                 # a memory limit; a CPU limit only if you mean to throttle
          readinessProbe: { httpGet: { path: /ready, port: 8080 }, periodSeconds: 5 }
          livenessProbe: { httpGet: { path: /health, port: 8080 }, initialDelaySeconds: 10, periodSeconds: 10 }
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
```
- Readiness decides whether a pod gets traffic (and whether a rollout progresses); liveness restarts it. A liveness probe that checks dependencies (the database) restarts healthy pods during an outage - keep it to "the process is alive". Slow starters: a `startupProbe`, not a long initialDelay.
- `maxUnavailable: 0` keeps capacity during a rollout; a PodDisruptionBudget keeps it during node drains.
- Config in ConfigMaps, secrets in Secrets (from a secret manager, not committed); change a checksum annotation to roll pods when config changes.

## Rollouts
1. `diff` - read what changes (an image tag, an env var, a replica count). Nothing unexpected.
2. `apply` - it waits; a rollout that does not finish shows the pods and their warnings.
3. Verify: `rollout-status`, `get` pods (ready, restarts 0), `events` (no new Warnings), the smoke check (an HTTP call).
4. Unhealthy: `rollout-undo` at once (back to the previous ReplicaSet), verify again, then debug at leisure.
A rollout that "hangs" is almost always new pods that never become ready: maxUnavailable 0 keeps the old ones serving, which is the point.

## Debugging
| Symptom | Look at | Usual cause |
|---|---|---|
| CrashLoopBackOff | `logs` with `previous: true`; `describe` (Last State: exit code, reason) | The app exits at start: missing env/config/secret, bad command or args, cannot reach a dependency, migrations failing. Exit 137 + OOMKilled: memory limit too low. Exit 1/2: the app's own error - the previous logs say which. |
| ImagePullBackOff / ErrImagePull | `events`, `describe` | Wrong tag or registry, private registry without imagePullSecrets, architecture mismatch. |
| Pending | `describe` (Events: FailedScheduling) | Requests larger than any node, node selectors/taints/affinity that match nothing, an unbound PersistentVolumeClaim. |
| Running, 0/1 ready | `describe` (Readiness probe failed), `logs` | Wrong probe path or port, the app listens on 127.0.0.1 instead of 0.0.0.0, a dependency the readiness check needs. |
| CreateContainerConfigError | `describe` | A referenced ConfigMap/Secret or key does not exist. |
| Restarts climbing | `logs previous`, events | Liveness probe too strict, memory leak (OOMKilled), unhandled crash. |
Read the event message and the previous container's last lines before changing anything; fix the cause in the manifest or the app, not the symptom (a longer probe delay hides a slow start, it does not fix a crash).

## Helm
- `template` + validate before installing; values per environment in files, secrets from the environment's secret store, not values files in git.
- Pin chart versions; `helm lint` in CI.
