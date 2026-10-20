import type { Effort } from '../core/models.ts';
import type { ToolHost } from '../runtime/host.ts';

// A workflow is a graph whose nodes do work and whose edges route on outcomes.
// The point of the graph is the parts a model should NOT decide: order,
// verification, human approval, retries with limits, resumability. The
// open-ended work happens inside agent nodes, each a full agent loop with its
// own fresh context - graphs wrap loops, they do not replace them.

/** Where to go next: one node, or a choice keyed by the node's outcome. */
export type Next = string | { on: Record<string, string>; default?: string };

interface Base { title?: string; next?: Next }

export interface AgentNode extends Base {
  type: 'agent';
  /** A registered sub-agent definition (its prompt, tools, model, effort); default "general". */
  agent?: string;
  /** The brief. {{input.x}}, {{state.node}}, {{feedback}} are filled in. */
  prompt: string;
  model?: string;
  effort?: Effort;
  /** Model calls this step may make (default 150, capped by the server's HARNESS_MAX_STEPS). */
  maxSteps?: number;
  /**
   * Outcome words the agent must state (e.g. ["APPROVE", "REQUEST_CHANGES"]):
   * the first one found in its report becomes the outcome `next` routes on.
   */
  decide?: string[];
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
  /** Outcomes: "ok" | "fail". */
}

export interface ParallelNode extends Base {
  type: 'parallel';
  /** Nodes run concurrently (each must not set `next`); their outcomes land in state. */
  branches: string[];
}

export interface CodeNode extends Base {
  type: 'code';
  /** TypeScript workflows only. Returns an output for state, and optionally the outcome to route on. */
  run(ctx: WorkflowContext): Promise<{ output?: unknown; outcome?: string } | void>;
}

export interface BranchNode extends Base {
  type: 'branch';
  /** Templated value whose (trimmed, lowercased) text is the outcome, e.g. "{{input.approval}}". */
  value: string;
}

export interface EndNode { type: 'end'; title?: string; status?: 'success' | 'failed'; next?: undefined }

export type WorkflowNode = AgentNode | GateNode | ApprovalNode | ShellNode | ParallelNode | CodeNode | BranchNode | EndNode;

export interface WorkflowDef {
  name: string;
  description: string;
  /** Inputs the run needs, with descriptions (shown in the UI). */
  inputs?: Record<string, { description: string; required?: boolean; default?: string }>;
  start: string;
  nodes: Record<string, WorkflowNode>;
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
}

/** What the runner needs from its host session. */
export interface WorkflowHost {
  host(): Promise<ToolHost>;
  runAgent(args: { agent: string; label: string; prompt: string; model?: string; effort?: Effort; maxSteps?: number; signal: AbortSignal }): Promise<{ report: string; reason: string; cost: number }>;
  runGates(names: string[] | 'applicable', signal: AbortSignal): Promise<{ name: string; pass: boolean; summary: string; details?: string; severity?: string }[]>;
  approve(args: { runId: string; node: string; title: string; message: string; files: string[] }): Promise<{ approved: boolean; feedback?: string }>;
  emit(e: { kind: 'workflow'; run: RunRecord; node?: string; phase: 'started' | 'node_started' | 'node_finished' | 'finished' }): void;
  save(run: RunRecord): Promise<void>;
}

export interface WorkflowContext {
  run: RunRecord;
  host: ToolHost;
  signal: AbortSignal;
}
