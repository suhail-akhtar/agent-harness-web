# Changelog

## 1.0.0

- Security review of the person's own code, gated by an oracle (docs/swarm/SWARM.md, phase 4):
  - **`confirm_finding`**: runs a finding's reproducer in the workspace. It counts only when the reproducer exits 0
    with its marker. Every run is kept in the plugin's own ledger, outside the workspace.
  - **`check_fix`**: a fix is accepted when the reproducer no longer fires and the tests pass.
  - **`findings`**: the confirmed, unconfirmed and fixed findings.
  - **The `findings-confirmed` gate**: a report may call a finding CONFIRMED or FIXED only when the ledger says so,
    and must list every confirmed finding.
  - **The `security-review` workflow**: a lead ranks the files in scope by risk and sends one hunter per file group,
    then a reporter writes the report.
  - **The mandate** (`.harness/security-mandate.json`: scope, who authorized it, dates): written by the person.
    Swarm agents cannot write it.
- **`scan_code`**: Semgrep where installed, else built-in rules. Each match is a candidate.
- **Isolated runs**: reproducers and fix tests run in a fresh container of the sandbox image, with no network. The
  mandate's "isolate" controls it (auto, docker, off).
- **`fix_variants`**: variant analysis. It reads the repository's security-fix commits and lists the places in scope
  that still look like the code each fix removed: the same line, or the same call to a sink under other names. The
  lead runs it first.
