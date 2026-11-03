# Skill patterns

## Instructions only

For judgement: a writing style, a review checklist, a company's conventions, how to talk to a kind of customer.
SKILL.md holds the rules with an example of each; long material (a style guide, a glossary) goes in references/ and
is linked by path. No scripts: there is nothing exact to compute.

## Workflow

For work in steps where each step can be checked. Number the steps; for each, say what to do, what "done" looks
like, and how to check it before going on (a command to run, a file that must exist, a number that must match).
Name the failure that is common at each step and what to do about it.

## Scripted (tool-backed)

For exact work: parse a file format, convert between formats, compute totals or statistics, validate data against
rules, generate documents from templates, diff or reconcile two sources. The script does the work; SKILL.md says when
to run which script and how to read what it prints.

<a id="scripts"></a>
### Rules for scripts

1. **A real command line**: arguments for inputs and options, `--help` that explains them. No interactive prompts.
2. **Results as JSON on stdout** (or the file it writes, named in its output), so the agent reads them exactly.
3. **Errors on stderr, with a non-zero exit code** and a message that says what to fix. Never exit 0 on failure.
4. **Deterministic**: the same input gives the same output. No hidden state, no network unless the skill declares it
   (and then say so in SKILL.md).
5. **Standard library first**: Python's or Node's own modules. A dependency means a line in SKILL.md telling how to
   install it, and a check at the top of the script that says so clearly when it is missing.
6. **Small and focused**: one script per job; a shared module for what several use.
7. **Tested**: tests/ runs each script on a sample and checks the output, exiting 0 only when it is right.

Paths: scripts run from the workspace (the person's folder); the skill's own folder is in `$SKILL_DIR` (for its
assets: `$SKILL_DIR/assets/...`).

## Integration (MCP or API)

For another system. If an MCP server exists for it, put it in mcp.json (`{"mcpServers": {"name": {"command": ...,
"args": [...]}}}` or `{"url": ...}`) and its name in `mcp-servers`: the person switches it on when the skill is
imported. Otherwise a script calls the API, its credentials from the environment (never in the skill), and the
skill says which variables it needs.

## Choosing

- Would two careful people do it the same way every time? Then a script.
- Does it need taste, context or judgement? Then instructions.
- Most good skills are both: instructions that call scripts at the exact steps.
