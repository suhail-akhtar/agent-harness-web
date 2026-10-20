---
name: cite-sources
description: The citation format research reports use, and the rules the citation check enforces.
---
# Citing sources

Cite with numbered markers and a reference list at the end:

```
The protocol was announced in November 2024 [1]. It defines two transports [2].

## References
[1]: https://example.org/announcement
[2]: https://example.org/spec/transports
```

Rules (checked by `check_citations` and the `citations` gate):
- Cite only pages read in this session with web_fetch (the `sources` tool lists them). A search result you did not open is not a source.
- One marker per claim, at the end of the sentence it supports; several sources as `[1][3]`.
- A "quotation" in double quotes must be the source's exact words (at least a few words; the check compares word for word, ignoring case and spacing).
- A figure (a percentage, an amount of money, a number with three or more digits, a year) in a cited sentence must appear in a cited source as written. A figure you calculated goes in its own sentence, which ends with "(derived: <the arithmetic>)", e.g. "That is about 2.4 times as many [1][2] (derived: 1,200 / 500)." Such sentences are not figure-checked, so keep sourced figures out of them.
- Every [n] used in the text has a "[n]: URL" line in the references, and every reference is used.
- Never cite a page for something it does not say. If no source supports a sentence, cut it or label it as your assessment.
