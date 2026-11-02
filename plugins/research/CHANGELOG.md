# Changelog

## 1.1.0

- The claim ledger: `verify_claims` judges each cited sentence against the passage of the page it cites, on a model of another family that sees only the two (a "supported" must quote the page word for word), and writes research/claims.md; the `claims` gate (run only where a workflow names it) fails on an unsupported or contradicted claim; deep-research runs it after the citation check, with a fix round, and the fact-checker reads the ledger.

## 1.0.0

- Shipped with the harness; its own tests in test/, its bundle details (publisher, links, tags, harness versions) in harness-plugin.json.
