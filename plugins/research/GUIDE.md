---
name: research-guide
description: Research with checkable sources: search and read, parallel researchers, cited reports, citation and fact checks.
---

# Research (research)

## What it is for

Answering questions from sources: a deep-research report, a comparison of options, the state of
the art, a literature review, a fact-check of a claim. Every claim in the answer is cited to a page
that was actually read in this session, and the citations are checked. Use it when the person asks
a question whose answer lives on the web or in documents, wants sources, or asks "is it true that".

## How work runs

- **deep-research** (workflow): a research lead plans the questions, researchers search and read
  in parallel, a writer drafts the report with numbered citations, `check_citations` verifies every
  cited URL was fetched and every quotation appears, and a fact-checker reviews the claims.
- **Tools**: `web_search` and `web_fetch` (the session's), `sources` (the pages read so far: list,
  or read one again without fetching), `check_citations` (run it before you hand over a report).
- **Agents**: research-lead, researcher, research-writer, fact-checker.
- **Skills**: research-method, cite-sources. **Gate**: `citations`.

## Pages and navigation

- Research prompts (a board of starting points): `desktop_open {"target":"view","id":"research:prompts"}`
  (in the sidebar under More); the home: `desktop_open {"target":"view","id":"research"}`.
- The person can type `/research <question>`; the palette has "Start deep research".

## Worked examples

**"Compare Postgres and MySQL for our analytics workload, with sources"**: plan the comparison
axes, search and read primary sources (docs, benchmarks), write a table of trade-offs with numbered
citations, run `check_citations`, fix any it flags, then answer.

**"Fact-check: X reduces Y by 40%"**: find the primary source of the number, read it, say what it
actually measured and how sure you are, cite it.

**"A full report on ..."**: run the `deep-research` workflow (or start it from the palette); keep
the report as an artifact (markdown) so the person can keep and edit it.
<!-- generated -->
