# Security review (security-review)

## What it is for

A security review of the person's own code, where a finding is something proven, not suspected. Use it when the
person asks to check their code for vulnerabilities, or to fix one.

## How work runs

- **The mandate first**: the person writes `.harness/security-mandate.json`, for example
  `{"scope": ["src/**"], "authorizedBy": "<name>", "from": "2026-11-01", "until": "2026-11-30"}`. Nothing runs
  outside its scope or its dates, and agents cannot write it.
- **security-review** (workflow): the security-lead ranks the files in scope by risk and sends security-hunter agents
  over them. Each hunter brings a reproducer for each flaw it believes real; the harness runs it (`confirm_finding`)
  and keeps the run in its own ledger. The security-reporter writes `security/findings.md`, and the
  `findings-confirmed` gate holds it to the ledger.
- **A fix**: `check_fix` runs the finding's reproducer again (it must no longer fire) and the tests (they must pass).
- **Tools**: `confirm_finding`, `check_fix`, `findings`. **Agents**: security-lead, security-hunter,
  security-reporter. **Gate**: `findings-confirmed`.
