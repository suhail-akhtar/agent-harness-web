---
name: visual-verification
description: How to check visual work (documents, slides, charts, web pages, games, 3D) with the render and browser tools, playtest.json, and what to look for. Use before you call any visual deliverable done.
---
# Look at it before you say it is done

Tests prove behaviour; only looking proves a slide is readable or a scene is lit. Two tools:

- `render {path, pages?, width?}`: documents, decks, sheets, PDFs, Markdown, SVG, HTML to page images. It also reports, without eyes: page count, words per page, and **slide text that does not fit** (LibreOffice drops what falls off the slide). Fix every "TEXT DOES NOT FIT".
- `browser {path, actions?, eval?}`: opens a workspace page **offline** (only workspace files load) and reports uncaught errors, console errors, missing files, blocked network requests, a screenshot (flagged BLANK if one colour) and the values you read with `eval`.

If you cannot see images (the result says so), rely on the text checks, `eval` values and the gates.

## Documents and slides
After each build: `render` the file, then check, page by page:
1. Nothing cut off, overlapping or running off the edge; no empty placeholder boxes.
2. Text is readable at the rendered size: body text at least 14 pt on slides; at most ~6 bullets of ~10 words.
3. One clear title per slide that states the point ("Costs fell 12%"), not a topic ("Costs").
4. Consistent fonts, colours, margins and alignment across pages; contrast is strong.
5. Charts: labelled axes, units, readable labels, no clipped legend.
Look at every page (use `pages: "5-8"` for more than four).

## Web pages, games, 3D
- Vendor libraries with `add_library` (three, pptxgenjs, docx, jszip). CDN links are blocked in the check, and a sandbox has no network.
- Expose state for tests: `window.__game = { state, score, player, ... }` (or `window.__app`), updated every frame.
- WebGL: `preserveDrawingBuffer: true` so screenshots show the frame; a fixed timestep; `?seed=N` for deterministic randomness.
- Drive it: `browser {actions: [{"press":"ArrowRight","hold":500},{"eval":"window.__game.player.x"},{"screenshot":"after moving"}]}`.
- Write `playtest.json` so the `playtest` gate checks behaviour every time:

```json
{
  "page": "index.html",
  "viewport": { "width": 960, "height": 600 },
  "scenarios": [
    { "name": "starts on the title screen", "expect": [{ "eval": "window.__game.state", "op": "==", "value": "title" }] },
    { "name": "Enter starts the game", "steps": [{ "press": "Enter" }, { "wait": 300 }], "expect": [{ "eval": "window.__game.state", "op": "==", "value": "playing" }] },
    { "name": "right arrow moves the player", "steps": [{ "press": "Enter" }, { "press": "ArrowRight", "hold": 600 }],
      "expect": [{ "eval": "window.__game.player.x", "op": "increased" }] }
  ]
}
```
`op`: `==` `!=` `>` `>=` `<` `<=` `truthy` `falsy` `includes`, or `increased` `decreased` `changed` (compared with the value before the steps). A scenario also fails on uncaught errors or a blank screen.

## What to report
What you looked at (pages, screenshots), what you fixed after looking, and anything you could not verify.
