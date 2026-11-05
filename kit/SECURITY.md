# Security of the kit

## What the build guarantees

A kit is not built if any of these is true:

- the working tree differs from a commit;
- a package that ships has a high or critical advisory (`npm audit`);
- it would contain an environment file, a key file, a private key, any value from the builder's `.env`, or a symbolic link.

A flag that loosens one of these is recorded in `BUILD.json`, so check that file on a kit you did not build yourself.

## What the signature proves

Every file is hashed, and the list is signed with the publisher's Ed25519 key. `harness verify` fails if a file was changed, added or removed. `harness start` and `harness run` do the same check first and refuse a kit that fails.

**The limit:** the check runs from inside the kit, with the kit's own copy of the public key. It catches damage, mistakes and casual edits. Someone who can rewrite the kit can also rewrite the check. For a real check, keep the public key somewhere else and verify the archive before unpacking it, using a kit you already trust:

```bash
node <trusted kit>/bin/harness.mjs verify --key <your copy of the key>.pub.pem --archive harness-kit-<version>.tgz
```

The key id to expect is `bd8ef1c0207c42ed`.

## Defaults when running

- The server listens on `127.0.0.1` and needs a token. Auth can only be turned off on loopback.
- API keys come from the environment or the vault, never from the kit.
- Permissions: a session asks before acting, `dontAsk` refuses what it would have asked, and `bypass` still asks before a message or payment goes to someone the person never named.
- Without Docker, commands in a local folder run with your account's access and network. Use the Docker sandbox for code you do not trust.

## Before exposing a server

- Set `HARNESS_TOKEN`, put TLS in front of it, and create accounts (`harness users`).
- Set spend caps: `HARNESS_MAX_COST_USD` and `HARNESS_USER_DAILY_USD`.
- Require signed plugins with a trust list.

## Not covered

- The kit is built for one platform (`BUILD.json`): DuckDB and esbuild include native binaries.
- Advisories are as of the build date. Rebuild to pick up new fixes; a kit does not update itself.
