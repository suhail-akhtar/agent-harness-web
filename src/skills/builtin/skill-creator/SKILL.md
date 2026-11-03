---
name: skill-creator
description: Make a new skill for the person - from instructions alone to a fully scripted, tested skill with its own scripts, references, assets and MCP servers - check it, and keep it in their skill library for their conversations and agents. Use when the person asks to create, build, turn something into, or improve a skill.
allowed-tools: write, edit, read, glob, bash, check_skill, save_skill, skill_script
---
# Making a skill

A skill teaches an agent one kind of work well, and is loaded only when that work comes up. Build the smallest skill
that does the job right, and no smaller: instructions for judgement, code for anything that must be exact.

## 1. Understand the work

Ask for (or infer from the conversation) two or three real examples of the task, what a good result looks like, and
what goes wrong today. A skill is only as good as the examples it was built from.

## 2. Choose the kind of skill

Read [references/patterns.md](references/patterns.md) before you decide. In short:

| The work needs | Build |
|---|---|
| judgement, a style, a checklist, conventions | instructions only (SKILL.md, maybe references/) |
| steps in a fixed order with checks between them | a workflow in SKILL.md, each step with how to verify it |
| exact results: parsing, converting, computing, validating, generating files | scripts/ that do it, with tests/ |
| another system: an API, a database, a service | an MCP server in mcp.json, or a script that calls it, and the tools it needs in `allowed-tools` |

Code beats instructions whenever the same input must always give the same output: a model computing a total by hand
gets it wrong one time in twenty; a script never does.

## 3. Lay it out

Start from the scaffold: `skill_script` with skill `skill-creator`, script `scripts/init_skill.mjs`, args
`["skills", <name>, "<description>", "--scripts", "--references", "--assets", "--tests", "--mcp"]` (only the parts you
need). The first argument is the folder the skill goes IN (it makes `skills/<name>/`), not the skill's own folder. It
writes:

```
<name>/
  SKILL.md         frontmatter: name, description (what it does AND when to use it), allowed-tools, mcp-servers
  scripts/         the code (Python, JavaScript/TypeScript, shell)
  references/      what the agent reads only when needed (long docs, schemas, examples)
  assets/          templates and data the scripts use
  tests/           self-tests: each runs the scripts on samples and exits 0 only when the output is right
  mcp.json         {"mcpServers": {...}}: servers the skill brings (the person switches them on)
```

## 4. Write it

- **description**: the only thing an agent sees before it loads the skill: say what it does, and the words a person
  would use when they need it.
- **SKILL.md**: under 500 lines; the procedure, each script with when to run it and what it prints, how to check the
  result; link everything in references/ by path.
- **scripts**: follow the rules in [references/patterns.md](references/patterns.md#scripts): a real command line
  (`--help`), JSON on stdout for results, errors on stderr with a non-zero exit, no network unless the skill says so,
  the same output for the same input.
- **tests**: one test per script at least, on a sample in `assets/` or inline, checking the actual output.

## 5. Check, then keep

Run `check_skill` on the folder and fix every PROBLEM (notes are advice). It runs the tests: all must pass. Then
`save_skill`: it is in the person's library from their next conversation on, and theirs to give to their agents
(Agents > Your agents > skills).
