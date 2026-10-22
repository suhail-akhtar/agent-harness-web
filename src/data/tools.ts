import fs from 'node:fs/promises';
import path from 'node:path';
import { type OpFamily, OPS } from '../../packages/plugin-ui/src/bi.ts';
import type { Tool, ToolKind } from '../tools/types.ts';
import { applyOps, type ApplyResult, type Op, READS } from './ops.ts';
import type { DataService } from './service.ts';

// The agents' tools: datasource, dataset, model, dashboard. Each is a thin door onto the same op
// layer the app uses, limited to its family of ops; `help` returns the dashboards skill (loaded only
// when needed, so sessions that never make a dashboard pay nothing for it).

export interface DataToolService {
  apply(ops: Op[]): Promise<ApplyResult>;
  help(): Promise<string>;
}

let skill: Promise<string> | undefined;
export const dashboardsSkill = () => (skill ??= fs.readFile(path.join(import.meta.dirname, 'skill.md'), 'utf8'));

/** What a session's tools reach: the owner's data, changes recorded as this session's agent. */
export function dataServiceFor(svc: DataService, o: { owner: string | undefined; sessionId: string; workspace?: string }): DataToolService {
  const home = svc.home(o.owner);
  return {
    apply: (ops) => applyOps(svc, home, ops, { kind: 'agent', account: o.owner, session: o.sessionId, label: `agent:${o.sessionId}` }, { workspace: o.workspace }),
    help: dashboardsSkill,
  };
}

const RISKY = new Set(['add_source', 'update_source', 'publish']);
const opsOf = (i: Record<string, unknown>): Op[] => (Array.isArray(i.ops) ? i.ops as Op[] : i.op ? [i as Op] : []);

function makeTool(family: OpFamily, description: string): Tool {
  const mine = Object.entries(OPS).filter(([, v]) => v.family === family).map(([k]) => k);
  return {
    kind: 'edit', parallelSafe: false, remoteable: false,
    kindsFor: (i) => {
      const ops = opsOf(i);
      if (!ops.length || ops.every((x) => x.op === 'help' || READS.has(x.op) || x.op === 'refresh' || x.op === 'test_source' || x.op === 'verify')) return ['read'];
      return ops.some((x) => RISKY.has(x.op)) ? ['external'] : ['edit'];
    },
    // Writes persist beyond the session (confirmed after untrusted content); sources and publishing ask the person.
    persists: (i) => opsOf(i).some((x) => !READS.has(x.op) && x.op !== 'help' && x.op !== 'refresh'),
    sendsOut: (i) => opsOf(i).some((x) => x.op === 'publish'),
    spec: {
      name: family,
      description,
      input_schema: { type: 'object', properties: { op: { type: 'string' }, ops: { type: 'array', items: { type: 'object' } } } },
    },
    summarize: (i) => { const ops = opsOf(i); return `${family} ${ops.map((x) => x.op).join(', ')}`.slice(0, 160); },
    async run(input, ctx) {
      const data = ctx.services?.data as DataToolService | undefined;
      if (!data) return { content: 'Dashboards are not available in this session.', is_error: true };
      const ops = opsOf(input);
      if (ops.some((x) => x.op === 'help')) return { content: await data.help() };
      if (!ops.length) return { content: `Give op (one of: ${mine.join(', ')}, help) or ops [{op, ...}]. op help explains everything.`, is_error: true };
      const foreign = ops.find((x) => !mine.includes(x.op));
      if (foreign) {
        const other = OPS[foreign.op]?.family;
        return { content: other ? `${foreign.op} belongs to the ${other} tool.` : `"${foreign.op}" is not an op of ${family}: ${mine.join(', ')} (op help for examples).`, is_error: true };
      }
      try {
        const r = await data.apply(ops);
        const lines = r.results.map((x) => x.message).filter(Boolean);
        if (r.diff.length) lines.push(`changed:\n${r.diff.join('\n')}`);
        if (r.changed.length) lines.push(`versions: ${r.changed.map((c) => `${c.target} v${c.version}`).join(', ')} (undo with dashboard {op:"undo", doc} or target "catalog")`);
        return { content: lines.join('\n'), ...(r.untrusted ? { untrusted: true } : {}) };
      } catch (e) { return { content: (e as Error).message, is_error: true }; }
    },
  };
}

export const DATA_TOOLS: Tool[] = [
  makeTool('datasource', 'Data sources for dashboards: files (csv/tsv/json/ndjson/xml/parquet/xlsx/geojson, logs), sqlite, postgres, mysql, mssql, mongodb, http APIs, static values. op: list_sources | add_source {source} | update_source {id, patch} | remove_source {id} | test_source {id}. Secrets only as a key vault entry name. op help: the full guide.'),
  makeTool('dataset', 'Datasets: named tables the engine computes (source + query-editor steps and/or one read-only SELECT). op: list_datasets | define | update_dataset | remove_dataset | add_step | update_step | remove_step | move_step | certify | set_dataset_refresh | set_incremental | set_storage | query {sql} | preview | profile | refresh. Results are capped summaries; never type numbers yourself.'),
  makeTool('model', 'Semantic model: tables, relationships, calculated columns, measures (incl. time intelligence), hierarchies, formats, row-level security. op: describe_model | add_model | set_model | set_table | set_column | set_relationship | set_measure | set_hierarchy | set_format | set_role | remove_* | model_query {query} | suggest.'),
  makeTool('dashboard', 'Dashboards and reports; every number comes from the engine. op: help (read first) | list_docs | describe | create | add_page | add_visual | update_visual | move_visual | set_interaction | add_filter | set_layout | apply_template | move_widget | set_theme | set_refresh | add_alert | set_narrative | drill | drillthrough | add_link | pin | bind | verify | publish | export | undo ... Batch: ops [{op,...}].'),
];

/** Whether a session gets these tools: an app that draws dashboards (HARNESS_DATA_TOOLS=on|off overrides). */
export function dataToolsFor(client: { renderers: string[] } | undefined): boolean {
  const env = process.env.HARNESS_DATA_TOOLS;
  if (env === 'off') return false;
  if (env === 'on') return true;
  return !!client?.renderers.includes('dashboard');
}
