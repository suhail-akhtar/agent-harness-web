# Changelog

## 1.0.0

- A forecasting ledger (docs/swarm/SWARM.md, phase 5):
  - **`forecast`**: several forecasters on different models, each from the outside view first. The aggregate is
    computed in code: a trimmed mean in log-odds, extremized by sqrt(3), capped to 2-98%.
  - **`resolve_forecast`**: a question is resolved with the source that settled it.
  - **`forecast_scores`**: Brier and log scores per forecaster, for the aggregate and for any market; a calibration
    table; the extremizing factor refitted once 20 questions are resolved.
  - Live questions only.
