# Agents that notice things themselves: findings and design

Status: built (phase 5 in [PLAN.md](PLAN.md)): `src/core/noticing.ts`, the Noticing panel and the line by a
conversation's message box in the desktop app; tested in `test/noticing.test.ts` and
`test/desktop-e2e-noticing.test.ts`, and live on Claude Sonnet 5.5. This is the step after phases 0 to 4. In those phases, the person sets
up every proactive run (a schedule or a watch). Here, the agent notices on its own that something needs doing.

## What was built, and where it differs from the design below

- **Detectors 1 to 4 of the 6** in the table below. "Something you said to do later" and "repeated approvals" are not
  built yet; each would be a new detector judged by the same gates and measures.
- **No model at all.** Every message is a fixed template; the optional small-model veto is not used, so noticing costs
  nothing to run.
- **Findings are their own Inbox kind** (`noticed`), with the digest as their policy: a warning may interrupt, the
  rest waits (this fixes the first of the "two problems" below). Feedback carries the detector, and each detector has
  its own measures (the second).
- **Practice is the default** (7 days, then the Inbox offers the review), and nothing in practice is shown.
- Found while building it: the bash tool's own lines ("exit code: N", "stderr:") made every failed command look like
  the same error, here and in the progress review; a failure's gist now skips them.

## How this was decided

The question went to seven independent sources. None was shown another's answer or our conclusion.

- **Research agent:** reviewed work on proactive agents up to November 2026.
- **Skeptic agent:** asked to make the strongest case against the idea, then to keep only what survives.
- **Code agent:** mapped the signals our harness already records, with file and line references.
- **Model panel:** Claude Opus 5.5, Kimi K3.1 Pro and DeepSeek Flash, each given the same question with no tools. Their full
  answers are in [research/noticing/](research/noticing). The panel cost about $0.20.
- **Earlier research:** our report [RESEARCH.md](RESEARCH.md).

## Verdict: what is a myth and what is not

The myth is a model that watches everything you do and decides when to help. Every source rejected it, for three reasons:

- **Models fire too often.**
  - Models asked cold when to step in are right about half the time: 51 to 61% precision on ProAgentBench.
  - GPT-5.5 false-triggers 24% of the time on ProactiveMobile; the best fine-tuned model on ProactiveBench, 50%.
  - Asking the model to think step by step does not fix this reliably.
  - Models jump into a conversation too early: 46% of their interjections came before any human would have spoken (PITCH).
- **It costs a lot.** A small model checking every turn costs about $0.50 a day per person. A model reviewing the last 15
  minutes all day costs about $6 a day.
- **Products backed away from it.**
  - OpenAI reportedly retired ChatGPT Pulse in June 2026 and folded it into scheduled tasks.
  - Microsoft reportedly cancelled proactive Copilot features in Outlook and its mobile app in 2026.

  Both reports are secondary. The common lesson is that a proactive feature lasts when the person can steer it, ideally as a
  task they own.

What works is narrow noticing that counts things. Fixed rules count events and use no model. A model runs only after a rule fires,
only to write the message, and it may veto. Every finding should turn into something the person owns (a schedule, a watch, a
fix), not into repeated reminders. The best evidence:

- **A separate gate decides when to speak.**
  - It halved false triggers and cut compute by 69% (PRPF).
  - Gating on typing and editing activity doubled acceptance, from 18% to 34%, while skipping 35% of model calls.
  - Cursor shows a suggestion only when its chance of acceptance is above 25%. The result was 21% fewer suggestions and 28%
    higher acceptance.
- **Waiting for a natural pause matters.** It raised acceptance from 4.9% to 18.6%, and nearly ended rejections from people
  who never read the suggestion.

## The design all sources converged on

### 1. Watch by counting, with no model

Keep one compact activity ledger across conversations, `<data>/activity.jsonl`. It stores metadata only, never content:

- the tool, a normalized command key, an error fingerprint and whether a check passed;
- turn ends, the project, and whether the person was present;
- a hash of the prompt and a hash of the tool sequence.

Entries expire after 14 days. The ledger is written from the event hook every session already has
(`SessionDeps.onEvent`, wired in `src/kernel/harness.ts`).

Detectors are pure functions that run at natural boundaries: a turn ending, a session starting, or once an hour. They do not
run all the time.

### 2. Which detectors, in order of value

| # | Detector | Rule | Where it shows |
|---|---|---|---|
| 1 | Failed while you were away | A long conversation or unattended run ended in an error or a refusal while nobody was watching | Inbox, once, when you come back |
| 2 | Routine health | A schedule or watch has had no successful run for 3 of its intervals, or keeps hitting its spend cap | Inbox |
| 3 | Stuck on the same failure | The same command fails with the same error 3 times in 20 minutes, with no file edits in between, in a conversation you are driving | One line inside that conversation, offering to dig in. It does not step into the run by itself, because a study found that stepping in can lower success (the "Intervention Paradox") |
| 4 | Repeated manual task | The same command sequence or prompt, started by you, on 3 or more days within 14 days, with no matching schedule | A proposed schedule or watch built word for word from **your own** commands, opened in the schedule dialog for you to confirm |
| 5 | Something you said to do later | "Remind me tomorrow", "check after the deploy" (a fixed phrase pattern) | A proposed one-off schedule |
| 6 | Repeated approvals | You allowed the same rule 3 or more times across conversations | An offer to "always allow this in this project" |

Never build these:

- Advice on code quality or style.
- Guesses at your intent or mood.
- Anything about the file you are working on right now.
- Anything that CI, a linter or the type checker already reports.
- Anything caused by the agent's own changes.
- Anything triggered by text the agent read: files, web pages or tool output.

### 3. Gates before anything is shown, cheapest first

About 95% of candidates should stop here, before any model call.

1. Drop anything already seen: the same fingerprint, the same item already in the Inbox, or anything inside its cooldown.
2. **"You already know":** drop it if the related files or tests were touched in the last 15 minutes, or the error is
   visible in the current turn.
3. **Its own work:** ignore events from scheduled runs, linked sessions and routines it proposed, and changes the agent wrote.
   Nothing chains.
4. **Budgets:**
   - at most 3 suggestions a day and 1 interruption a day;
   - at most $0.05 a day of model spend for noticing;
   - **past the budget, a candidate is dropped, not queued**, so it never arrives late and out of context.
5. Only then, optionally, one small-model call with no tools: about 2k tokens in, 150 out, strict JSON. The model can
   only veto or word the message. It cannot pick or change the action.

### 4. The ladder

The rungs are silent (the default), suggest, ask, prepare and act.

- **Silent:** logged only.
- **Suggest:** an item in the Inbox, or a quiet strip in the conversation.
- **Ask:** an interruption. Only when waiting loses the value.
- **Prepare:** reproduce the problem, or draft a fix in a separate worktree. Later, and only for kinds of action you named.
- **Act:** not in this design.

Learning can only make it quieter:

| Dismissal reason | What changes |
|---|---|
| Wrong | That fingerprint is muted and the rule needs stronger evidence |
| Not useful | That kind of finding is muted for the project |
| Bad timing | Only when it is shown changes |
| Not opened within 72 hours | Counted as a soft "no" |

Moving a kind of finding up the ladder takes **your click**. A good acceptance record never does it automatically.

### 5. Prove it before showing anything

- **Shadow mode for the first 7 to 14 days.** The detectors run and record what they would have said, and nothing is shown.
  Then one review page, "here is what I would have told you", lets you calibrate it.
- **Holdout.** 10% of candidates are silently withheld, to measure whether you found the problem yourself anyway.

### 6. Turned off automatically

Each detector is judged on its own, over rolling 14 days with at least 5 findings:

- 30% or more dismissed as not useful or wrong: it moves to the digest.
- After that, still 50% or more: it is turned off, with a note in the Inbox.
- Under 15% acted on after 10 findings: it is turned off.
- Any finding about the agent's own work: it is turned off until fixed.
- More than 5 findings a day: treated as a bug, and the detector stops.

Only you can turn a detector back on.

### 7. Safety

- The ledger stores fingerprints, not content. It covers only places you already gave the harness, and has a "what I
  observe" view and an off switch.
- Actions come from a fixed list. Their arguments come from the detector, never from text the agent read. A README saying
  "run X" can never become a suggestion to run X.

## Two problems in today's code to fix first

1. `decideAlert` (`src/core/initiative.ts:76`) treats every suggestion as important. A self-made finding would get past
   "only when it matters". Findings need their own setting, with the digest as the default.
2. `scheduleStats` groups by `scheduleId`, so a detector would have no usefulness numbers. Feedback needs a detector
   field and stats for each detector.

## Where the sources disagreed, and the call

| Question | Positions | Call |
|---|---|---|
| Moving up the ladder | DeepSeek: automatically after 5 accepts in a row. Everyone else: only by the person | **Only by the person** (it avoids autonomy creeping up as attention fades) |
| Acting on its own | Kimi: only to stop its own futile retries. Opus: prepare, never apply. DeepSeek: a short safe list | **No acting in the first version.** Preparing comes later, only for kinds the person names |
| Asking versus suggesting | DeepSeek: asks should be rarer than acts; a card with the draft ready beats a question | **Suggest with the draft ready.** Ask only when waiting loses the value |
| Learning per person | DeepSeek: overrated early. Opus: a per-detector estimate | Fixed thresholds plus "only quieter" rules first; per-detector numbers only to make it quieter |
| Shadow length | Opus: 7 days. Kimi: 14 days | 7 days, or 30 candidates, whichever comes later |

## Cost

| Design | Cost per person per day |
|---|---|
| A small model checking every turn | about $0.50 |
| A mid-size model with context | about $5 |
| A model reviewing the last 15 minutes all day | about $6 |
| **This design** | **under $0.01**. Most findings need no model, and a capped few cost about $0.002 each |

## Still unknown

- No vendor has published acceptance numbers for self-made suggestions.
- No one knows how often "repeated" really means "worth automating".
- There is no real-world evidence that learning per person beats a fixed threshold.

These are why shadow mode, the holdout and the automatic turn-off rules are part of the design and not optional.

## Main sources

- PRPF / ProactiveMobile: arXiv 2606.03236
- PRISM: arXiv 2602.01532
- Telemetry gate: arXiv 2511.18849
- Adaptive timing: arXiv 2511.18842
- Cursor Tab online RL: cursor.com/en/blog/tab-rl
- ProAgentBench: arXiv 2602.04482
- PITCH: arXiv 2610.25896
- Intervention Paradox: arXiv 2602.03338
- Pop-up attacks: arXiv 2411.02391
- Task mining: arXiv 2008.05782
- InvisibleMentor: arXiv 2509.26557
- Jules suggested tasks: jules.google/docs/suggested-tasks
- Pulse retirement and Microsoft reversals: secondary press (digit.in, windowslatest.com)
- Earlier sources are in [RESEARCH.md](RESEARCH.md).
