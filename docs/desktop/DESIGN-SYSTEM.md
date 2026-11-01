# The desktop app's design system

Every page, dialog and plugin page is built from one kit, `packages/ui` (`@harness/ui`), on one set of tokens. A
change made in the kit changes every place that uses it. A page never makes its own copy of a heading, a card,
a choice row or a note. `test/ui-standards.test.ts` enforces this. To see every component in both themes, open
the component gallery from the Command palette: "Open the component gallery".

## Tokens

### Type: nine roles

Each role is a share of the person's Text size (Settings > Appearance, 14px by default), so that setting scales
all text. A pixel size such as `text-[13px]` fails the standards test.

| Class | At 14px | Use |
|---|---|---|
| `text-display` | 26 | the home greeting, a stat's number |
| `text-heading` | 20 | a page title (Page draws it) |
| `text-title` | 16 | a dialog title, an empty panel's title |
| `text-body-lg` | 14 | a list item's name, a prominent line |
| `text-body` | 13 | most text: rows, forms, buttons |
| `text-small` | 12.5 | help under a field, a card's description, small buttons |
| `text-caption` | 11.5 | facts, times, counts (Meta) |
| `text-tiny` | 11 | the section label (Section draws it), badges |
| `text-micro` | 10.5 | key caps, tiny counts |

Weights: `font-semibold` for titles and headings, `font-medium` for labels, names and buttons, regular for the
rest. Markdown reading text is 15px at the default size and follows the setting too.

### Colour

Every colour is a token the theme builder (`packages/ui/src/theme.ts`) makes from three colours (background,
text, accent), for light and dark, with contrast checks.
- **Surfaces:** `bg-hx-bg` (the page), `bg-hx-surface`, `bg-hx-elevated` (cards, dialogs), `bg-hx-sidebar`,
  `bg-hx-pill` (tracks, neutral badges), `bg-hx-code`.
- **Text:** `text-hx-primary`, `text-hx-secondary`, `text-hx-muted`.
- **Borders:** `border-hx-border-subtle` (cards), `border-hx-border` (inputs, hover).
- **Tones:** `accent`, `success`, `warning`, `danger`, `info`. Each has its colour (`text-hx-danger`), a fill
  (`bg-hx-danger-soft`) and a border (`border-hx-danger-border`). A tone with an opacity (`bg-hx-danger/10`)
  fails the standards test. A meter's track is the one listed exception.

**What a tone means, everywhere** (`statusTone()` maps a status word to one):

| Tone | Meaning |
|---|---|
| accent | the app's own colour: selection, the app at work (running) |
| success | done, healthy |
| warning | needs the person (waiting, skipped, stopped) |
| danger | failed, destructive |
| info | neutral news |
| neutral | everything else |

### Space, radius, elevation

- **Space:** a 4px grid.
  - Cards pad 16px (`padding="md"`) or 12px (`"sm"`).
  - Sections stand 32px apart on a page and 20px apart in a dialog (`dense`), with 10px under the label.
  - A page's content starts 32px under the window bar and has a 24 to 32px gutter.
- **Radius:**

  | Class | Size | Use |
  |---|---|---|
  | `rounded-md` | 6px | small controls, icon tiles |
  | `rounded-lg` | 8px | inputs, buttons, option cards, callouts |
  | `rounded-xl` | 12px | cards, popovers, toasts |
  | `rounded-2xl` | 16px | dialogs |
  | `rounded-full` | | pills, dots |

- **Elevation:** flat by default.
  - Cards have a border and no shadow.
  - Popovers and toasts use `shadow-pop`.
  - Dialogs use `shadow-modal` over a scrim.

## Components

| Need | Use | Notes |
|---|---|---|
| A page | `Page` | It scrolls and draws `PageHeader` (title, subtitle, actions, optional `icon`). Widths: `normal` for every page of lists, cards and settings (one width, so the content never jumps between pages), `narrow` for a single form, `wide` for dashboards and galleries. |
| A group on a page or in a dialog | `Section` | The one section label, with optional `description`, `count` and `actions`; `dense` in dialogs. |
| A surface | `Card` | `padding`, `interactive`, `selected`, `tone`, `muted` (switched off). |
| Numbers on a home page | `StatGrid` + `StatCard` | `tone` from the map above. |
| A note, an error, a banner | `Callout` | `tone`, `title`, `actions`, `variant="banner"`, `onDismiss`. `InfoNote` is a Callout. Never a hand-made red paragraph. |
| One of a few | `ChoiceGroup` | Chips by default; `variant="segmented"` for two to four short options. Arrow keys move it. |
| One of a few, each explained | `OptionCards` | |
| Some of a list | `CheckboxGroup` | `mono` for names such as tools. |
| Facts in a line | `Meta` | Dot-separated, caption size. |
| A status | `StatusDot` (`status` or `tone`), `Badge` | |
| What a thing is | `IconTile` | `sm`, `md` or `lg`, with a tone. |
| Nothing yet | `EmptyState` | `variant`: `page`, `section` (a dashed box) or `inline` (one line). `PageState` for loading or failed. |
| Rows | `ListRow` | `card` for a page's list. |
| Controls | `Button` (five variants, three sizes), `IconButton` (label required), `Input`, `Textarea`, `Select`, `Switch`, `Checkbox`, `Field` (label, help, error), `Tabs` | |
| Decisions | `Modal` (footer: a ghost Cancel, then the primary action), `ConfirmDialog` (or `useApp().ask`), `ActionPanel` (an inline approval) | |
| Notes that something happened | `toast()` | At most three at once; a repeat replaces the one on screen; errors stay until dismissed. |

## Rules

1. Use a kit component when one fits. When none does, add it to `packages/ui` and to the gallery, then use it.
   Don't style a one-off copy in a page.
2. Text uses a type role, and colour uses a token. No pixel sizes, no hex colours, no opacity on a tone.
3. One page width for list, card and settings pages. A page's buttons sit in its header, the primary one last.
4. Status colour comes from the tone map: running is accent, waiting is warning, failed is danger.
5. Every control works from the keyboard and has a visible focus ring; an icon-only button has a label.
6. Data attributes (`data-*`) name things for tests and for agents that drive the app. A redesign keeps them.
