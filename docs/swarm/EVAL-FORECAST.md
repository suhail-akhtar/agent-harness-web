# The forecasting ledger, live (phase 5)

`scripts/live-forecast.mjs`, 2026-11-02. Raw results and the ledger: [EVAL-FORECAST.json](EVAL-FORECAST.json).

## Setup

Three live questions, asked as a person would. Each was still open when it was asked, and each resolves between
9 December 2026 and 1 January 2027.

- **Models**: the conversation on Claude Haiku 5.5; the forecasters on Claude Sonnet 5.5, Claude Haiku 5.5 and
  Grok 4.7, with web search.
- **What can be checked now**: no score says anything about skill until the questions resolve, so the run checks
  the parts that can be: each forecaster's probability, the code's aggregate, and the ledger's records.

## Final run: 13 of 13, $1.12

| Question (as the forecasters framed it) | Resolves | Sonnet | Haiku | Grok 4.7 | Aggregate (code) |
|---|---|---|---|---|---|
| Will the Bank of England reduce Bank Rate at its 17 December 2026 decision? | 2026-12-17 | 0.01 | 0.03 | 0.04 | 0.02 |
| Will the FOMC lower the federal funds target range at its 8-9 December 2026 meeting? | 2026-12-09 | 0.02 | 0.02 | 0.02 | 0.02 |
| Will Bitcoin close above $150,000 on 31 December 2026 (CoinMarketCap)? | 2027-01-01 | 0.01 | 0.01 | 0.01 | 0.02 |

- **Each forecaster's work**: each gave a probability from its own brief, started from a stated base rate (for
  example 15% for a cut at any given Bank of England meeting), then moved by the evidence it read.
- **The aggregate**: in each case it is what the code computes from the three.
- **The ledger**: each question is kept with its resolution criteria and date.
- **Refusal**: a question already decided (the 2024 Olympics) is not forecast.

All three aggregates sit at the 2% floor. Extremizing pushes forecasts that are already low past the cap, so for
near-certain "no" questions the cap, not the forecasters, decides the number. Whether 2% is too high a floor is for
the resolved questions to show.

## What the runs before it found (and what was fixed)

- **The ledger was bypassed.** The conversation's agent called the forecaster agents itself, through the agent tool,
  so nothing reached the ledger or the code's aggregate. Forecasters are now reachable only through `forecast`
  (`disable-model-invocation`); the same was done for the data-answers recomputer.
- **Grok 4.7's probability went unread.** Its JSON was spread over lines before a closing remark. Any JSON block with
  a probability is now read, and a forecaster with none is asked once more.
- **A question that was already decided.** A first run asked about Artemis II flying with crew before April 2027. It
  had flown in April 2026, and the agent found that and refused to forecast it. The mistake was ours, and the agent
  was right.
