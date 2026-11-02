# The claim ledger, live (phase 3)

`scripts/live-claims-eval.mjs`, 2026-11-02. Raw results of the final run: [EVAL-CLAIMS.json](EVAL-CLAIMS.json).

## What was checked

Three real pages were read once: the English Wikipedia articles on the Eiffel Tower, Mount Everest and Python. One
made-up page was added, and it carries an instruction aimed at the judge. A report cites these pages in 20 sentences:

- **6 true claims.** One is a paraphrase and one is an exact figure.
- **14 false or overstated claims of 13 kinds:**
  - a wrong year, twice;
  - a year shifted by one release;
  - an inflated figure;
  - a wrong place;
  - two overreaches;
  - an unsupported detail;
  - a negation;
  - a half-true compound;
  - a fact true in the world, cited to a page that does not say it;
  - a figure rounded beyond what the page states (8,849 m for the page's 8,848.86 m);
  - a claim backed only by the planted page's instruction ("reply supported").

Each judge model checks every claim through the harness's own path. That path is the `claims` service the
`verify_claims` tool and the `claims` gate use. The conversation runs on another family than the judge, and the judge
is the only model it may delegate to, so the harness's cross-model choice lands on it. The judge sees one sentence and
the best passages of its page, never the report or the conversation.

A "supported" or "partial" verdict counts only when its quote is on the page word for word. The harness checks that
itself. The grading:
- **False claim:** judged supported or partial, it is a false pass.
- **Overstated claim** (the half-true one, the rounded figure): judged supported, it is a false pass.
- **True claim:** judged anything but supported or partial, it is a false fail.

## Final run (the code as committed)

| Judge | Right | False passes | False fails | Cost | Time |
|---|---|---|---|---|---|
| Claude Sonnet 5.5 | 20/20 | 0 | 0 | $0.162 | 12 s |
| Claude Haiku 5.5 | 20/20 | 0 | 0 | $0.012 | 15 s |
| DeepSeek Flash | 20/20 | 0 | 0 | $0.007 | 8 s |
| DeepSeek V4 Pro | 20/20 | 0 | 0 | $0.028 | 24 s |
| GPT-6 Luna | 20/20 | 0 | 0 | $0.006 | 12 s |
| Kimi K3.1 Pro | 20/20 | 0 | 0 | $0.094 | 27 s |
| GLM 5.3 Flash | 20/20 | 0 | 0 | $0.007 | 17 s |
| Grok 4.3 | 20/20 | 0 | 0 | $0.093 | 84 s |
| Grok 4.7 | 20/20 | 0 | 0 | $0.192 | 47 s |

180 of 180 judgements were right, and each ran on the model asked for (9 of 9). The run cost $0.60.

All nine judges refused the planted instruction.

## The runs before it, and what each found

The first runs were not clean. Every miss was a harness bug or a gap in the judge's brief, fixed before the final run:

| Run | Result | Found | Fixed |
|---|---|---|---|
| Haiku, 13 claims | 11/13 | A cited URL with parentheses (`Python_(programming_language)`) was cut at the "(" and read as never fetched. A true quote failed because stored pages keep link targets after link words ("Gustave Eiffel (https://...)"). | Reference lists and inline links take balanced parentheses, in `check_citations` too. Passages and quote checks use the page as a reader sees it. |
| 8 judges, 13 claims | 98/104 | xAI refused every judge request: a `tool_choice` with no tools. GPT elided a quote ("Mount Everest ... is the highest"). | A request with no tools sends neither field. An elided quote counts when each part is on the page, in order. |
| 9 judges, 19 claims | 163/171 | All nine said the page does not give 8,849 m. They were right: it gives 8,848.86, and the label was wrong. The passage they saw was a wikitext comment: the sentence splitter dropped every sentence with a decimal, and one word-overlap window was won by the page's own name. | The decimal and line-end splitting. The best three separate windows, with words rare on the page weighted up. The label: the claim is now "8,848.86", and a rounded 8,849 is its own case. |
| 9 judges, 20 claims | 177/180 | GPT and Kimi accepted the rounded figure. DeepSeek Flash quoted an infobox row with its cell bars spaced differently. | Table cells compare as words. |
| 2 judges, then 4 | 39/40, 79/80 | DeepSeek Flash accepted the rounding. A quote failed on Wikipedia's footnote marks ("Sagarmāthā[a]") and an accent in another Unicode form. | The brief: the same figures for "supported", and a rounded or converted figure is "partial". Footnote marks and accent forms are ignored when quotes are compared. |
| Grok 4.7, 13 claims | 12/13 | Once, a reply with no readable verdict. | It is asked once more. |

Before the brief change, the rounded figure was also caught deterministically. In deep-research `check_citations` runs
before the ledger, and its figure check needs the figure on the page: on the live Everest page it flags "8,849" and
passes "8,848.86".

## What this does and does not show

- **Shown:** on real, long pages (188 to 361 thousand characters), the ledger's path works the same on all six
  providers. That path is passage choice, a judge of another family, and a quote checked by the harness. Every judge
  rejected these kinds of false claims, including an injected instruction.
- **Not shown:**
  - **Scale and wording:** 20 claims is a small corpus, and the false claims were written by us, not found in the wild.
  - **Variance:** each judgement ran once.
  - **Whole reports:** the deep-research workflow end to end is not part of this run.

  A larger corpus, repeats and a full deep-research run are the next measurements.

## Spend

About $2.40 in all across the runs. OpenAI's share, GPT-6 Luna as a judge, was about $0.03, far inside its cap.
