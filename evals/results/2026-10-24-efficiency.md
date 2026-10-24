# The efficiency package, measured (2026-10-24)

Five changes, each behind a setting, measured before and after:

1. **Deferred plugin tool schemas** (`efficiency.deferPluginTools`, `HARNESS_DEFER_PLUGIN_TOOLS`): a plugin's tools are a group shown as one line in `load_tools` until the session loads it.
2. **Spilled tool output** (`efficiency.spill`, `HARNESS_SPILL`): output past a tool's limit is kept whole in `<workspace>/.harness/spill/<session>/`, the agent gets head, tail, path and line count.
3. **Batched masking** (`efficiency.batchedMasking`, `HARNESS_MASK_BATCHED`): non-Anthropic models mask old tool output past half the compaction point, in one batch of everything older than 8 steps, only when it frees 15% of the compaction point.
4. **Cache-miss attribution** (`efficiency.cacheAttribution`, `HARNESS_CACHE_ATTRIBUTION`): a miss is named by the first prompt section that changed.
5. **1-hour prefix TTL on Claude** (`promptCaching.prefixTtl`, `HARNESS_PREFIX_TTL`: `5m`, `1h`, `auto`).

Harness: branch `worktree-agent-aef22ab6288385364` (the runs used commits 1a8b703 to 2dbdb19; nothing between them changes a request), native Windows 11, Node 22.21, Docker Desktop for the sandbox (`HARNESS_EVAL_SANDBOX` left at `auto`: commands ran in Docker, only the workspace mounted). Configurations: [`evals/efficiency-ablation.json`](../efficiency-ablation.json) and, for the long case, [`evals/efficiency-ablation-long.json`](../efficiency-ablation-long.json) (compaction at 60K tokens in both rows, so masking happens within a short run). One run per configuration and model unless marked; these are observations, not statistics.

**One deviation from "all five off" in the baseline:** cache attribution stays on in both rows. It only hashes what is sent (no request changes, no model call; `test/efficiency.test.ts` checks the request is the same with it off), and without it the baseline would have no misses by cause to compare.

## Before: what the tool list costs

`node scripts/run.mjs scripts/tool-schema-size.ts` (no model call; tokens are characters / 4), with every bundled plugin on:

| Session | Tools | Schema tokens per request |
|---|---|---|
| Plain (as eval runs make), deferral off | 51 | ~25,600 |
| Plain, deferral on | 28 (27 + `load_tools`) | ~8,350 |
| Desktop client (its 4 desktop tools, artifacts, chapters), deferral off | 61 | ~26,600 |
| Desktop client, deferral on | 38 | ~9,360 |

Where the 17K tokens went: games3d 12 tools ~7.2K, devops 5 tools ~2.6K, the four engine plugins one tool each ~1.5-2.2K, visual 3 tools ~0.8K. research (2 tools, ~240 tokens) stays inline: a group under ~400 tokens costs about as much as its load. In the devops eval sessions below the full list was ~22,100 tokens (the plain list less the tools that need a host they do not have); deferred, ~8,400 before a load and ~11,000 with the devops group loaded.

## After: the runs

Every scored run passed every hidden check in both configurations. "Prompt/request" is the mean prompt (uncached + cache read + cache write) per model request; "Schema/request" the estimated tool-schema tokens per request; "Steps" the model calls; "Misses by cause" the cache misses (`src/core/cache.ts`: a request that read less than half of what the request before it cached).

| Case | Model | Config | Result | Cost | Input tokens | Prompt/request | Cache hit | Schema/request | Steps | Misses by cause | Spilled | Masked |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| devops/fix-terraform | deepseek-flash | baseline | pass 2/2 | $0.008 | 433,780 | 33,368 | 92% | 22,065 | 13 | none | 0 | 0 |
| devops/fix-terraform | deepseek-flash | efficiency | pass 2/2 | $0.009 | 350,600 | 19,478 | 91% | 10,875 | 18 | tools 1 | 0 | 0 |
| devops/fix-k8s-manifests | deepseek-flash | baseline | pass 2/2 | $0.003 | 293,202 | 32,578 | 98% | 22,065 | 9 | none | 0 | 0 |
| devops/fix-k8s-manifests | deepseek-flash | efficiency | pass 2/2 | $0.003 | 111,113 | 18,519 | 90% | 10,595 | 6 | none | 0 | 0 |
| games3d/fix-softlock (compaction at 60K) | deepseek-flash | baseline | pass 4/4 | $0.107 | 4,577,333 | 36,042 | 94% | 11,493 | 127 | mask 2 | 0 | 56 |
| games3d/fix-softlock (compaction at 60K) | deepseek-flash | efficiency | pass 4/4 | $0.102 | 4,471,264 | 34,661 | 96% | 7,907 | 129 | mask 2 | 0 | 36 |
| devops/fix-terraform #1 | claude-sonnet-5-5 | baseline | pass 2/2 | $0.110 | 319,414 | 45,631 | 96% | 22,065 | 7 | none | 0 | 0 |
| devops/fix-terraform #1 | claude-sonnet-5-5 | efficiency | pass 2/2 | $0.093 | 185,328 | 26,475 | 91% | 10,657 | 7 | none | 0 | 0 |
| devops/fix-terraform #2 | claude-sonnet-5-5 | baseline | pass 2/2 | $0.189 | 316,523 | 45,218 | 85% | 22,065 | 7 | none | 0 | 0 |
| devops/fix-terraform #2 | claude-sonnet-5-5 | efficiency | pass 2/2 | $0.167 | 186,421 | 26,632 | 74% | 10,657 | 7 | tools 1 | 0 | 0 |
| devops/fix-k8s-manifests #1 | claude-sonnet-5-5 | baseline | pass 2/2 | $0.143 | 131,952 | 43,984 | 66% | 22,065 | 3 | none | 0 | 0 |
| devops/fix-k8s-manifests #1 | claude-sonnet-5-5 | efficiency | pass 2/2 | $0.186 | 197,527 | 28,218 | 74% | 10,657 | 7 | tools 1 | 0 | 0 |
| devops/fix-k8s-manifests #2 | claude-sonnet-5-5 | baseline | pass 2/2 | $0.074 | 177,062 | 44,266 | 94% | 22,065 | 4 | none | 0 | 0 |
| devops/fix-k8s-manifests #2 | claude-sonnet-5-5 | efficiency | pass 2/2 | $0.064 | 73,232 | 24,411 | 79% | 10,162 | 3 | none | 0 | 0 |

Per configuration and model, all runs together:

| Model | Config | Passed | Cost | Input tokens | Steps | Misses by cause |
|---|---|---|---|---|---|---|
| deepseek-flash | baseline | 3/3 | $0.119 | 5.30M | 149 | mask 2 |
| deepseek-flash | efficiency | 3/3 | $0.114 | 4.93M | 153 | tools 1, mask 2 |
| claude-sonnet-5-5 | baseline | 4/4 | $0.517 | 0.94M | 21 | none |
| claude-sonnet-5-5 | efficiency | 4/4 | $0.510 | 0.64M | 24 | tools 2 |

The cache-hit share is lower in some efficiency rows on Sonnet because the prompt is smaller (the cached part shrank more than the uncached part), not because of more misses. Not counted above: the first efficiency run of fix-softlock, which the runner left unscored because the machine slept for 307 minutes in the middle of it ($0.071 spent; 87 steps until then, 39 results masked in 4 batches, misses `mask` 3); it was run again.

## What each change did

**1. Deferred plugin tools: helped; on.** In every devops run the agent loaded the `devops` group without being told about it: the prompts say "load the terraform-practices (kubernetes-operations) skill first", and loading a plugin's skill loads its tools. In fix-softlock the workflow is the games3d plugin's own, so its agents had games3d's tools from the start and only the other groups waited. The schemas a request carried fell from ~22,100 tokens to ~8,400 (before the load) and ~11,000 (after), and the mean prompt per request by **40-45% in the short cases on both models** (DeepSeek fix-terraform 33.4K -> 19.5K, fix-k8s 32.6K -> 18.5K; Sonnet fix-terraform 45.6K -> 26.5K and 45.2K -> 26.6K, fix-k8s 44.0K -> 28.2K and 44.3K -> 24.4K), and by 4% in the long one (its workflow agents carry fewer tools to begin with, 5K and 2.8K tokens of schemas; the fix agent's fell from 16.1K to 11.7K).

- Cost on Sonnet: where the two runs took the same path, **-12% to -15%** (fix-terraform $0.110 -> $0.093 and $0.189 -> $0.167, 7 steps each; fix-k8s #2 $0.074 -> $0.064). The first fix-k8s pair went the other way, **+30%** ($0.143 -> $0.186): the efficiency run took 7 steps to the baseline's 3 (its first validation and a gate failed, and it fixed them), and its load came at the second request with nothing cached yet, so the prefix was written twice (19.8K, then 26.4K tokens). Its cost per step was still lower ($0.027 vs $0.048). All four pairs together: $0.517 -> $0.510, flat, with 32% fewer input tokens over 3 more steps.
- Cost on DeepSeek: flat ($0.119 -> $0.114 over three cases). Its cached input costs $0.003 per million tokens, so 14K fewer cached tokens per request save almost nothing; the gain there is a smaller context (later compaction, faster requests).
- What a load costs: one cache miss at most, attributed `tools` (3 of the 6 short efficiency runs). In the others the request after the load read the new prefix from the cache because an earlier session had loaded the same group: the list is rendered in one canonical order, so sessions with the same loaded set share a cached tools + system prefix. On DeepSeek a load did not always register as a miss (fix-k8s read 12.4K of the 13.7K prompt after the tool list changed). On Sonnet a load early in a session is repaid within about five steps (the prefix written twice against ~11K fewer tokens read per step).
- No run called a deferred tool before loading it, and no run failed for want of a tool.

**2. Spilled tool output: not triggered live; on.** No tool output in these runs passed its limit (bash's 30K characters, `run_script`'s 20K, 120K for any result), so nothing was spilled in either configuration and the runs are no evidence either way. When it does trigger, the agent sees the same number of characters as before (head and tail within the same limit) and the middle stays readable instead of lost. `test/efficiency.test.ts` covers writing, the line count, redaction, the git-ignore, the disk cap, the fallback to clipping, removal with the session, and the read tool reading the middle back. Kept on: it costs nothing when it does not trigger, and saves the filtered re-run an agent otherwise makes.

**3. Batched masking: neutral to slightly better; on.** Only fix-softlock (DeepSeek, compaction lowered to 60K so a short run gets there) reached the masking point. The old rule cleared 56 results in 6 events; batched masking masked 36 in 4 batches. Misses attributed to masking: 2 and 2 (most clears change the prompt late enough that more than half still reads from the cache). Cache hit 94% -> 96%, cost $0.107 -> $0.102, with deferral in the same row, so the share of each change cannot be separated in one run. At 60K both rules' minimum batch is the same (12K tokens); at a model's default compaction point (160K for DeepSeek) batched masking waits for 24K tokens of old output, so it should break the cache about half as often, which these runs did not reach. No run re-read masked output in a loop. Claude keeps its server-side clearing (unchanged).

**4. Cache-miss attribution: works; on (it costs nothing).** Every miss in these runs was named and matched what happened: `tools` on a group load, `mask` after the harness masked or cleared old results. The short cases' baselines had no misses. It changes no request (tested: identical requests with it on and off) and makes no model call.

**5. 1-hour prefix TTL: correct, not exercised by the eval runs; `auto` stays the default.** No tool call in these runs came near 4 minutes (the longest was a 72-second playtest) and no gap between requests passed 5 minutes, so `auto` never switched, as designed: it does nothing until a session shows gaps the 5-minute cache cannot bridge. One direct live check on Sonnet 5.5 (two requests, $0.031): the API accepted `cache_control: {type: "ephemeral", ttl: "1h"}` on the system block with the automatic 5-minute tail breakpoint after it, reported `cache_creation.ephemeral_1h_input_tokens` = 7,219 of the 7,275 tokens written, the second request read those 7,219, and the harness priced the 1-hour writes at $4.00/M (2x input) and the rest at $2.50/M. By the arithmetic, on Sonnet the 1-hour prefix pays for itself at the first gap of 5-60 minutes (an extra $1.50/M once against a $2.50/M rewrite per gap); `1h` always would pay the extra in every session, for nothing in sessions like these.

## Defaults chosen

| Setting | Default | Why |
|---|---|---|
| `efficiency.deferPluginTools` | on | ~40% smaller prompts per request on both models; cost -12% to -15% on Sonnet where runs took the same path, flat overall and on DeepSeek; at most one miss per group per session. |
| `efficiency.spill` | on | Never triggered here (neutral); keeps output that clip() used to discard, at the same context cost. |
| `efficiency.batchedMasking` | on | Fewer masking events (4 vs 6) and masked results (36 vs 56) for the same misses and the same pass; neutral to slightly positive. |
| `efficiency.cacheAttribution` | on | Observation only: no request change, no cost. |
| `promptCaching.prefixTtl` | `auto` | Nothing until a long gap is seen; shape and pricing verified live; `1h` always would add writes for nothing in short sessions. |

## What did not help, or was not shown

- Deferral did not lower DeepSeek's cost (its cache reads are almost free), and on one Sonnet pair the efficiency run cost more because it took a longer path and paid for its prefix twice. With one or two runs per cell a 12-15% difference is within run-to-run noise: the second fix-terraform baseline cost 72% more than the first on the same path, from a colder cache.
- Spill and the 1-hour TTL never triggered in an eval run: they are verified by unit tests and (the TTL) one direct API check, not by an A/B.
- Batched masking's main claim (about half as many cache breaks at the default compaction point) needs longer runs than this budget allowed; at 60K it was compared with the old rule at the same minimum batch.
- A load on Claude is a full prompt-cache miss when no other session has the same loaded set cached. Anthropic's server-side tool search (`defer_loading` on the deferred tools) would avoid that miss; it is not used here.

## Spend

Live model spend for this measurement: **$1.36** of the $2.00 cap (eval runs $1.331, including the unscored run, plus $0.031 for the direct TTL check). Each eval run was capped with `maxCostUsd` 0.30; none reached its cap (the largest was $0.189).

