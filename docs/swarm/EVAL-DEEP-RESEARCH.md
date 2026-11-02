# The deep-research workflow end to end, live (phase 3)

`scripts/live-deep-research.mjs`, 2026-11-02. The run's files: [report](EVAL-DEEP-RESEARCH-report.md),
[claim ledger](EVAL-DEEP-RESEARCH-claims.md), [counter-evidence](EVAL-DEEP-RESEARCH-counter.md),
[fact-check](EVAL-DEEP-RESEARCH-fact-check.md), [results](EVAL-DEEP-RESEARCH.json).

## Setup

The question, as a person would ask it: "When do the EU AI Act's obligations apply? I need the dates for the bans,
for general-purpose AI models and for high-risk systems, and whether any of them have been delayed."

- **Models**: the conversation and every agent on Claude Haiku 5.5; web search through Anthropic; the claim ledger's
  judge on Grok 4.7, the other family.
- **Grading**: from the files and the stored pages.

## Result: 9 of 11 checks, 24.7 minutes, $2.36

The judging on Grok 4.7 was $1.74 of the cost, search $0.39, Haiku $0.23.

Passed:
- The report was written, from 29 pages read.
- It cites only pages that were read, and passes `check_citations`.
- The claim ledger was written, judged on Grok 4.7.
- The counter-evidence search and the fact-check were written.
- The answer gives the dates for the bans (2 February 2025), for general-purpose AI (2 August 2025) and for most of
  the rest (2 August 2026).
- It found the Digital Omnibus (Regulation (EU) 2026/1744, in force 27 July 2026), which delayed the high-risk dates
  to 2 December 2027 and 2 August 2028, and cited it.

Failed:
- **The answer does not state the entry into force (1 August 2024).** The question did not strictly ask for it, so
  this item of the truth list was ours.
- **The final ledger still lists 2 unsupported claims**, yet the workflow ended "Report ready": the last fact-checker
  approved despite them.

## What it found, and what was fixed

- **The workflow trusted a fact-checker's approval over the ledger.** Deep-research now ends through a final claims
  gate, with a fix round: "Report ready" only when no claim is unsupported or contradicted, else "Report ready, with
  open fact-check findings".
- **18 of 58 claims were never judged**: the ledger stopped at 40 claims a run. The limit is now 100, eight judged at
  once.
- **Fragment claims.** The sentence splitter broke on "Art. 5" and on sites named in the prose
  ("artificialintelligenceact.eu"). It now keeps both, and the usual abbreviations, whole.
- **Correct quotes judged unverifiable.** A claim citing two pages had its quote put together from both, and quotes
  carried elisions ("..."). Each part is now matched on one of the claim's pages. 24 of 58 claims had been
  unverifiable for these reasons and the cap.

The workflow was not rerun end to end after these fixes; the fixes have deterministic tests (`test/claims.test.ts`).
