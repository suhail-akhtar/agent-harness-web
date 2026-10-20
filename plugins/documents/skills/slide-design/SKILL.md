---
name: slide-design
description: How to make a deck a senior audience trusts - storyline, action titles, one idea per slide, layout grid, type sizes, colour, charts - and the checklist to judge a rendered slide. Use when outlining, building or reviewing slides.
---
# Slide design

## Storyline first
- Start from the one sentence the audience must leave with. Lead with it (answer first), then the support (pyramid: answer, 3-4 reasons, evidence).
- One idea per slide. The **title is a full sentence stating the point**: "Churn fell to 2.1% after onboarding changes", never "Churn".
- Reading only the titles in order must tell the whole story.
- Typical shape: title, executive summary (the answer + 3 points), 1 slide per point with evidence, risks/asks, next steps.

## Layout (16:9, 13.33 x 7.5 in)
- Margins 0.5-0.6 in on every side. Title at the top in the same place on every slide (y 0.35-0.45, h ~0.9).
- A grid: full width, or two columns (e.g. 6.0 in + 6.0 in with a 0.33 in gap). Align everything to it; equal gaps.
- White space is design. Leave at least 15% of the slide empty.
- Footer: source line and slide number, small and quiet.

## Type
- Title 28-36 pt bold. Body 16-20 pt; never below 14 pt (12 pt only for sources and chart labels).
- At most ~5 bullets of ~12 words. Prefer a chart or a 2-3 column layout to a wall of bullets.
- Two fonts at most (one is better). Left-align text; centre only short titles on section slides.
- Never rely on auto-shrink: size the box for the text (see pptxgenjs-recipes).

## Colour
- One dark neutral for text, one light background (or the reverse), one accent for emphasis, one or two supporting colours. Use the accent only for what matters.
- Contrast: text at least 4.5:1 against its background. No light grey text on white.

## Charts and tables
- The chart's message goes in the slide title. Highlight the bar or line that proves it (accent colour; the rest muted).
- Label axes and units; show values with sensible precision (2.9, not 3); start bar axes at zero; no 3D, no gradients.
- Use a table only when exact values matter; at most ~6 rows x 5 columns on a slide; header row styled; numbers right-aligned.

## Review checklist (for every rendered slide)
1. Title states the point; the slide proves it.
2. Nothing cut off, overlapping, off the edge, or auto-shrunk to tiny text (render flags both).
3. Body text 14 pt or larger; contrast strong.
4. Aligned to the grid; consistent positions, fonts and colours with the other slides.
5. Charts: correct numbers from the source, labelled, readable.
6. No placeholder text, no "Lorem", no leftover template boxes, no typos.
