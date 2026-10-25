// The workflow file format in words, for an agent writing one (the workflow tool's "format"):
// what each node takes, how `next` routes, the templates, and a worked example. Kept next to the
// types it describes (src/graph/types.ts); test/workflow-authoring.test.ts proves its example valid.

export const WORKFLOW_EXAMPLE = {
  name: 'release',
  description: 'Test, prepare the release, ask a person, then commit and tag.',
  inputs: { version: { description: 'The version to release, e.g. 1.4.0', required: true } },
  start: 'test',
  nodes: {
    test: { type: 'shell', command: 'npm test', next: { on: { ok: 'prepare', fail: 'failed' } } },
    prepare: { type: 'agent', prompt: 'Set version {{input.version}} in package.json and add its section to CHANGELOG.md. Do not commit.', next: 'approve' },
    approve: { type: 'approval', message: 'Release v{{input.version}}?\n\n{{state.prepare}}', files: ['CHANGELOG.md'], next: { on: { approve: 'tag', reject: 'undo' } } },
    tag: { type: 'shell', command: 'git commit -am "chore(release): v{{input.version}}" && git tag -a v{{input.version}} -m v{{input.version}}', next: 'done' },
    undo: { type: 'shell', command: 'git checkout -- .', next: 'failed' },
    done: { type: 'end', status: 'success' },
    failed: { type: 'end', status: 'failed' },
  },
};

export const WORKFLOW_FORMAT = `A workflow is a JSON file in .harness/workflows/<name>.json (one workflow per file; it is picked up as soon as it is saved: "list" shows it, "check" says what is wrong with one that is not listed). The harness drives the graph, not a model: order, checks, a person's approval, bounded retries, and a run that resumes where it stopped.

Top level: {"name", "description", "inputs"?: {"<x>": {"description", "required"?, "default"?}}, "start": "<node id>", "nodes": {"<id>": node}, "state"?: {"<field>": {"type": "string|number|boolean|list|object", "reducer"?: "replace|append|merge|sum", "initial"?}}, "maxAgentRuns"?}

Nodes ("type" and its fields; every node but end has "next"):
- agent: "prompt" (required), "agent"? (a sub-agent name; default general), "model"?, "effort"?, "maxSteps"?, "decide"?: ["APPROVE", "REQUEST_CHANGES"] (the first word found in its report is the outcome), "outputs"?: [state fields it reports in a JSON block]. A fresh context each run; its report is {{state.<id>}}.
- shell: "command" (required), "timeoutMs"?. Outcomes ok | fail (or exit-N). Every {{...}} value is quoted as one argument. Shell steps run only where the project's commands are trusted (a sandboxed session, or HARNESS_TRUST_PROJECT=1); elsewhere a workflow with one is not loaded ("check" says so).
- gate: "gates": ["node-test", ...] or "applicable", "maxFailures"?. Outcomes pass | fail | exhausted; the evidence of a failure is {{feedback}} for the next step.
- approval: "message" (required, templated), "files"?: [paths shown with it]. A person answers; outcomes approve | reject (a rejection's reason is {{feedback}}).
- branch: "value": "{{input.mode}}" (its text is the outcome) or "when": "state.failures > 2 && input.mode != 'dry'" (outcome true | false).
- parallel: "branches": [node ids, each without its own next]; outcome all, or the first negative one.
- map: "over": "{{state.items}}", "node": {an agent or shell step using {{item}} and {{index}}}, "concurrency"?, "collect"?: a list field.
- end: "status": "success" | "failed".

"next": a node id, or {"on": {"<outcome>": "<node id>"}, "default"?: "<node id>"}. Templates: {{input.x}}, {{state.<node id>}} (its output), {{state.<field>}}, {{feedback}}. Writes: "writes": {"<field>": "{{output}}"} on any node.

Example:
${JSON.stringify(WORKFLOW_EXAMPLE, null, 2)}`;
