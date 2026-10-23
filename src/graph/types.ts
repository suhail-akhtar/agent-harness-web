import type { Effort } from '../core/models.ts';
import type { ToolHost } from '../runtime/host.ts';

// A workflow is a graph whose nodes do work and whose edges route on outcomes.
// The point of the graph is the parts a model should NOT decide: order,
// verification, human approval, retries with limits, resumability. The
// open-ended work happens inside agent nodes, each a full agent loop with its
// own fresh context - graphs wrap loops, they do not replace them.

/** Where to go next: one node, or a choice keyed by the node's outcome. */
export type Next = string | { on: Record<string, string>; default?: string };

interface Base {
  title?: string;
  next?: Next;
  /**
   * Writes to declared state fields when the node finishes, through each field's
   * reducer: { "failures": "1" } adds one to a summed counter. Values are templates;
   * {{output}} is this node's own output (report, command output, result list).
   */
  writes?: Record<string, string>;
}

export interface AgentNode extends Base {
  type: 'agent';
  /** A registered sub-agent definition (its prompt, tools, model, effort); default "general". */
  agent?: string;
  /** The brief. {{input.x}}, {{state.node}}, {{feedback}} are filled in. */
  prompt: string;
  /** A model id, or a template of the run's input ("{{input.reviewerModel}}"; empty: the session's model). Another model than the session's is a delegation. */
  model?: string;
  effort?: Effort;
  /** Model calls this step may make (default 150, capped by the server's HARNESS_MAX_STEPS). */
  maxSteps?: number;
  /**
   * Outcome words the agent must state (e.g. ["APPROVE", "REQUEST_CHANGES"]):
   * the first one found in its report becomes the outcome `next` routes on.
   */
  decide?: string[];
  /**
   * Declared state fields the agent reports: it is asked to end its report with a
   * fenced JSON block holding them, and each value goes into its field through the
   * field's reducer. A missing or mistyped block fails the node, or routes
   * "invalid-output" when `next` names it.
   */
  outputs?: string[];
}

export interface GateNode extends Base {
  type: 'gate';
  /** Gate names, or "applicable" for every registered gate that applies to the workspace. */
  gates: string[] | 'applicable';
  /** Outcomes: "pass" | "fail". After this many failures in one run, routes to "exhausted". */
  maxFailures?: number;
}

export interface ApprovalNode extends Base {
  type: 'approval';
  /** What the human is asked to approve (templated). Outcomes: "approve" | "reject". */
  message: string;
  /** Files (relative to the workspace) shown with the request. */
  files?: string[];
}

export interface ShellNode extends Base {
  type: 'shell';
  command: string;
  timeoutMs?: number;
  /** Outcomes: "ok" | "fail", or "exit-N" for exit code N when `next` routes it. */
}

export interface ParallelNode extends Base {
  type: 'parallel';
  /** Nodes run concurrently (each must not set `next`); their outcomes land in state. */
  branches: string[];
}

export interface CodeNode extends Base {
  type: 'code';
  /**
   * TypeScript workflows only. Returns an output for state, optionally the outcome to
   * route on, and optionally writes to declared state fields (through their reducers).
   */
  run(ctx: WorkflowContext): Promise<{ output?: unknown; outcome?: string; state?: Record<string, unknown> } | void>;
}

export interface BranchNode extends Base {
  type: 'branch';
  /** Templated value whose (trimmed, lowercased) text is the outcome, e.g. "{{input.approval}}". */
  value?: string;
  /**
   * Or a condition on state and inputs, routed as "true" / "false", e.g.
   * "state.failures > 2", "len(state.todo) == 0 && input.mode != 'dry'".
   */
  when?: string;
}

/** The step a map node runs once per item: an agent, shell or code node without its own `next`. */
export type MapTemplate = Omit<AgentNode, 'next'> | Omit<ShellNode, 'next'> | Omit<CodeNode, 'next'>;

export interface MapNode extends Base {
  type: 'map';
  /** The list to fan out over: "{{state.items}}", or a template that renders a JSON array. */
  over: string;
  /** Run once per item; its templates also see {{item}} (and {{item.field}}) and {{index}}. */
  node: MapTemplate;
  /** Items running at once (default 4). */
  concurrency?: number;
  /** A declared list field that receives every item's result, in item order (replace or append). */
  collect?: string;
}

export interface EndNode { type: 'end'; title?: string; status?: 'success' | 'failed'; next?: undefined }

export type WorkflowNode = AgentNode | GateNode | ApprovalNode | ShellNode | ParallelNode | CodeNode | BranchNode | MapNode | EndNode;

export type StateType = 'string' | 'number' | 'boolean' | 'list' | 'object';
/** How a write combines with the current value: replace it, append to a list, merge into an object, add to a number. */
export type Reducer = 'replace' | 'append' | 'merge' | 'sum';

export interface StateField {
  type: StateType;
  /** Default "replace"; "append" needs a list, "merge" an object, "sum" a number. */
  reducer?: Reducer;
  /** The value a run starts with (default: "", 0, false, [] or {}). */
  initial?: unknown;
  description?: string;
}

export interface WorkflowDef {
  name: string;
  description: string;
  /** Inputs the run needs, with descriptions (shown in the UI). */
  inputs?: Record<string, { description: string; required?: boolean; default?: string }>;
  start: string;
  nodes: Record<string, WorkflowNode>;
  /** Typed state fields, read as {{state.<field>}} and in branch conditions, written by nodes' `writes` and `outputs`. */
  state?: Record<string, StateField>;
  /** A cap on agent-node runs (fix loops included); exceeding it ends the run failed. */
  maxAgentRuns?: number;
  source?: string;
}

export interface NodeRecord {
  node: string;
  type: WorkflowNode['type'];
  status: 'running' | 'done' | 'failed' | 'waiting' | 'interrupted';
  outcome?: string;
  summary?: string;
  startedAt: number;
  endedAt?: number;
  cost?: number;
}

export interface RunRecord {
  id: string;
  workflow: string;
  sessionId: string;
  status: 'running' | 'waiting' | 'succeeded' | 'failed' | 'aborted' | 'interrupted';
  input: Record<string, string>;
  /** Node outputs (agent reports, gate summaries, approvals) by node id. */
  state: Record<string, string>;
  /** Declared state fields' values (WorkflowDef.state), saved with the run and kept across a resume. */
  values?: Record<string, unknown>;
  /** A map node in progress: its items, and the results of the items that finished (not re-run on resume). */
  maps?: Record<string, { items: unknown[]; results: Record<string, unknown>; outcomes?: Record<string, string> }>;
  /** The latest rejection or gate failure, offered to the next node as {{feedback}}. */
  feedback: string;
  current?: string;
  counts: Record<string, number>;
  agentRuns: number;
  history: NodeRecord[];
  createdAt: number;
  updatedAt: number;
  cost: number;
  error?: string;
  /**
   * Waiting (status "waiting") at `node` because what it needs (an agent, gate or tools) belongs to
   * a plugin that is switched off: it carries on from that node when the plugin is switched on.
   */
  paused?: { node: string; plugin: string; reason: string };
}

/** What the runner needs from its host session. */
export interface WorkflowHost {
  host(): Promise<ToolHost>;
  runAgent(args: { agent: string; label: string; prompt: string; model?: string; effort?: Effort; maxSteps?: number; signal: AbortSignal }): Promise<{ report: string; reason: string; cost: number }>;
  runGates(names: string[] | 'applicable', signal: AbortSignal): Promise<{ name: string; pass: boolean; summary: string; details?: string; severity?: string }[]>;
  approve(args: { runId: string; node: string; title: string; message: string; files: string[] }): Promise<{ approved: boolean; feedback?: string }>;
  emit(e: { kind: 'workflow'; run: RunRecord; node?: string; phase: 'started' | 'node_started' | 'node_finished' | 'finished' }): void;
  save(run: RunRecord): Promise<void>;
  /** Whether a node can run now: a reason (and the plugin) when what it needs is switched off. */
  blocked?(node: WorkflowNode): { plugin: string; reason: string } | undefined;
  /** The run paused at a node (see RunRecord.paused). */
  paused?(run: RunRecord): void | Promise<void>;
}

export interface WorkflowContext {
  run: RunRecord;
  host: ToolHost;
  signal: AbortSignal;
  /** In a map node's item: the item and its index. */
  item?: unknown;
  index?: number;
}
