# shop-web

The web front end of the shop. It listens on port 8080 (named `http`), serves
`/healthz` (the process is alive) and `/ready` (it can serve traffic), and
needs about 100m CPU and 128Mi of memory, never more than 256Mi. The current
release is `ghcr.io/acme/shop-web:2.4.1`. It runs as any non-root user and
does not write to its filesystem.
