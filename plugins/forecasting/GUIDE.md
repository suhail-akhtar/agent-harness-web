# Forecasting (forecasting)

## What it is for

Probabilities for yes/no questions about the future ("Will X happen by date Y?"), kept until they resolve and scored,
so the person can see over time how good the forecasts are. Use it when the person asks how likely something is.

## How work runs

- **forecast**: several forecaster agents on different models (each one the person allows; by default Claude Sonnet,
  Claude Haiku and Grok 4.7) start from the base rate, then the latest evidence, and each gives a probability. The
  harness aggregates them in code (a trimmed mean in log-odds, extremized, capped to 2-98%) and keeps the question
  with its resolution criteria. Only questions not yet decided.
- **resolve_forecast**: yes or no, with the source that settled it.
- **forecast_scores**: open questions; on resolved ones, each forecaster's, the aggregate's and any market's Brier
  and log scores, a calibration table, and the extremizing factor refitted once 20 questions are resolved.
- No score means anything about skill until questions resolve: never claim a forecast beats people or markets
  without resolved questions to show it.
