# Skills

A skill is know-how an agent loads when the work needs it. Every conversation lists each skill in one line. The full
instructions load only when the task matches, and a skill's own files load only when its instructions point to them.

## What a skill can be

| Kind | What it has | When |
|---|---|---|
| Instructions | `SKILL.md` alone | judgement, a house style, a checklist |
| Workflow | `SKILL.md` with steps, `references/` loaded at the step that needs them | a procedure with several parts |
| Scripted | `scripts/` that do the exact part, `tests/` that prove them | anything that must be exact or repeatable: parsing, matching, converting, computing |
| Integration | `mcp.json` (its MCP servers), or scripts calling an API | work on another system |

The skill-creator's `references/patterns.md` covers each kind in more depth.

## The layout

```
invoice-totals/
  SKILL.md            frontmatter, then the instructions
  scripts/total.py    run with skill_script; SKILL_DIR is the skill's folder
  tests/test_total.py each must exit 0; run by check_skill and save_skill
  references/...      loaded when SKILL.md says to
  assets/...          templates and data the scripts use
  mcp.json            {"mcpServers": {"name": {"command": ...} | {"url": ...}}}
```

### Frontmatter

| Key | Required | Rule |
|---|---|---|
| `name` | yes | lowercase letters, digits and `-`; 64 characters at most |
| `description` | yes | what the skill does and when to use it; 20 to 1024 characters |
| `version` | no | |
| `license` | no | |
| `allowed-tools` (or `tools`) | no | tools the skill needs; an agent given the skill gets them |
| `mcp-servers` | no | MCP servers the skill needs, by name; an agent given the skill gets them |

### Scripts

Scripts can be `.py`, `.mjs`, `.js`, `.cjs`, `.ts`, `.sh` or `.ps1`. An agent runs them with `skill_script` (`skill`,
`script`, `args`).

The harness copies the skill to `.harness/skills-run/<name>/` in the workspace and runs the script there, where the
session runs commands (on the server, in its sandbox, or on a person's computer). Arguments go to the script as they
are, and paths are relative to the workspace.

`skill_script` is an exec tool: permissions and hooks apply to it. An agent without `bash` can still run the scripts
of its skills.

## The checks

A skill is checked whenever it is imported or saved. It is kept only if it passes, and a skill of the same name is
replaced only when asked.

**What fails the check:**
- the name or the description;
- a file that SKILL.md names (in a link or in backticks) and that the skill does not have;
- a script that does not parse (`py_compile`, `node --check`, `bash -n`);
- an MCP server without a command or a url;
- a symbolic link;
- more than 1000 files, more than 5 MB in a file, or more than 20 MB in all.

**What only warns:**
- a SKILL.md over 500 lines;
- scripts with no tests.

`check_skill` and `save_skill` also run each test, and the skill is not kept if any test fails. Their output shows
each test's result.

### Zip packages

Packages are read with limits:
- 2000 entries;
- 20 MB per file and 60 MB in all, uncompressed;
- no path out of the folder and no drive letters.

## A person's library

Each person's skills are kept at `<data>/skills/<owner>/<name>/`. They are listed in all of that person's
conversations, before the project's skills and the harness's own (`skill-creator`).

| Route | What it does |
|---|---|
| `GET /api/me/skills` | the person's skills: their scripts, tests, references, assets, tools and MCP servers |
| `POST /api/me/skills/import` | `{data: base64}` for a `.skill` or `.zip` package, or `{text}` for a SKILL.md, with `replace` to replace a skill of the same name; returns each skill's check |
| `GET /api/me/skills/:name` | its SKILL.md and its files |
| `GET /api/me/skills/:name/export` | the skill as a `.skill` package (a zip of its folder) |
| `DELETE /api/me/skills/:name` | removes it |

### Importing packages

These packages import:
- an Anthropic `.skill`, or a `.zip` with SKILL.md at the root or in a folder;
- a pack of several skills, such as a Claude Code plugin's `skills/<name>/`;
- a SKILL.md on its own.

A SKILL.md nested inside a skill's folder (an example in `references/`, say) belongs to that skill and is not
imported separately. `__MACOSX` and `.DS_Store` are skipped.

A skill's MCP servers join the person's MCP servers switched off, marked `skill:<name>`, so the person turns them
on.

In the desktop app, **Agents > Your skills** lists the person's skills. From there they can import a package, make a
skill (this starts a conversation with the skill-creator), view a skill's SKILL.md and files, or remove it.

## Making a skill

Ask for one in your own words: "make me a skill for ...". The built-in `skill-creator` skill:
1. finds out what the work is;
2. chooses the kind of skill;
3. lays it out (`scripts/init_skill.mjs <dir> <name> "<description>" --scripts --tests --references --mcp`);
4. writes it: the scripts first, then tests that run them on real examples, then the SKILL.md that says when and how
   to use them;
5. checks it with `check_skill` and keeps it with `save_skill`.

## Skills on agents

An agent definition's `skills` (in the agent builder, or `skills:` in an agent file) gives it skills. Such an agent:
- starts with those skills' instructions;
- sees and loads only those skills;
- gets each skill's `allowed-tools` (added to its own `tools`) and `mcp-servers`;
- gets `skill_script` for the skills that have scripts.

## Proof

`test/skills-package.test.ts` covers:
- zips: reading them back, and the refusals;
- packages of each kind;
- the checks;
- the library;
- in the app: an import whose MCP server is added switched off, an agent that loads its skill and runs its script,
  and `check_skill` and `save_skill` refusing a skill whose test fails and keeping it once it is fixed.

`scripts/live-skills.mjs` is the live run. A person asks for a skill in their own words, for reconciling a bank
statement against invoices. Then an agent given that skill reconciles two real files with the skill's script, and its
answer is held to the known result.

Live results (2026-11-03). Each model made the skill and then used it as the agent, unless a second model is named.

| Model | Checks | Cost | Skill made |
|---|---|---|---|
| Claude Haiku 5.5 | 10/10 | $0.02 | `scripts/run.py`, its test, 58 lines of SKILL.md |
| Claude Sonnet 5.5, then Haiku 5.5 using it | 10/10 | $0.25 | `scripts/reconcile.py`, its test |
| Claude Opus 5.5 | 10/10 | $0.57 | `scripts/reconcile.py`, its test, 72 lines |
| DeepSeek Flash | 10/10 | $0.23 | `scripts/reconcile.py`, its test, 175 lines |
| DeepSeek V4 Pro | 10/10 | $0.21 | `scripts/reconcile.py`, its test, 120 lines |
| Kimi K3.1 Pro | 10/10 | $0.25 | `scripts/reconcile.py`, its test |
| GLM-5.3 | 10/10 | $0.22 | `scripts/reconcile.py`, its test |
| Grok 4.7 (effort high) | 10/10 | $1.57 | `scripts/reconcile.py`, its test, `references/matching.md` |

Grok 4.7's first try stopped at a $0.40 limit. It was still reasoning, having designed a minimum-cost bipartite
matching. Reasoning was 98% of its output, so Grok 4.7 now defaults to medium effort.

What the runs found and fixed:
- An agent without `bash` could not run its skill's scripts. Its `skill_script` went through the agent's own tools, so
  the command was refused.
- An agent given skills was still offered all of them.
- On DeepSeek V4 Pro, the scaffold nested a skill inside its own folder.
- The installer left out the `tests/` folders inside skills.
