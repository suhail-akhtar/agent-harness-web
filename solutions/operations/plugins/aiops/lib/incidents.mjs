// Incidents as files in the workspace, so they travel with the work and a
// person can read them: .harness/ops/incidents/<id>/incident.json (the record)
// and incident.md (rendered), plus postmortem.md when one is written.

export const INCIDENT_DIR = '.harness/ops/incidents';
export const SEVERITIES = ['sev1', 'sev2', 'sev3', 'sev4'];
export const STATUSES = ['investigating', 'identified', 'mitigating', 'monitoring', 'resolved'];

const iso = (t = Date.now()) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

export function newIncidentId(title, now = Date.now(), existing = []) {
  const d = new Date(now);
  const stamp = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const slug = String(title ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'incident';
  let id = `inc-${stamp}-${slug}`;
  for (let n = 2; existing.includes(id); n++) id = `inc-${stamp}-${slug}-${n}`;
  return id;
}

export function openIncident({ title, severity = 'sev3', services = [], summary = '' }, now = Date.now(), existing = []) {
  if (!String(title ?? '').trim()) throw new Error('open needs a title');
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  return {
    id: newIncidentId(title, now, existing), title: String(title).trim(), severity, status: 'investigating',
    services: [...new Set(services.map(String))], summary: String(summary ?? ''),
    openedAt: iso(now), updatedAt: iso(now),
    timeline: [{ at: iso(now), kind: 'opened', text: `Opened (${severity}): ${String(title).trim()}${summary ? ` - ${summary}` : ''}` }],
  };
}

export function updateIncident(inc, { status, severity, services, note, kind = 'note', at }, now = Date.now()) {
  const when = at ? iso(Date.parse(at)) : iso(now);
  if (at && Number.isNaN(Date.parse(at))) throw new Error(`"${at}" is not a time`);
  if (status !== undefined) {
    if (!STATUSES.includes(status)) throw new Error(`status must be one of ${STATUSES.join(', ')}`);
    if (status !== inc.status) inc.timeline.push({ at: when, kind: 'status', text: `Status: ${inc.status} -> ${status}` });
    inc.status = status;
  }
  if (severity !== undefined) {
    if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
    if (severity !== inc.severity) inc.timeline.push({ at: when, kind: 'severity', text: `Severity: ${inc.severity} -> ${severity}` });
    inc.severity = severity;
  }
  if (services?.length) {
    const added = services.map(String).filter((s) => !inc.services.includes(s));
    if (added.length) { inc.services.push(...added); inc.timeline.push({ at: when, kind: 'scope', text: `Affected: ${added.join(', ')}` }); }
  }
  if (note) inc.timeline.push({ at: when, kind: ['note', 'evidence', 'hypothesis', 'action', 'change', 'detection'].includes(kind) ? kind : 'note', text: String(note) });
  inc.timeline.sort((a, b) => a.at.localeCompare(b.at));
  inc.updatedAt = iso(now);
  return inc;
}

export function resolveIncident(inc, { root_cause, resolution, at }, now = Date.now()) {
  if (!String(root_cause ?? '').trim()) throw new Error('resolve needs root_cause: one sentence naming the technical cause');
  updateIncident(inc, { status: 'resolved', at }, now);
  inc.rootCause = String(root_cause).trim();
  inc.resolution = String(resolution ?? '').trim();
  inc.resolvedAt = at ? iso(Date.parse(at)) : iso(now);
  inc.timeline.push({ at: inc.resolvedAt, kind: 'resolved', text: `Resolved. Root cause: ${inc.rootCause}${inc.resolution ? `. Resolution: ${inc.resolution}` : ''}` });
  return inc;
}

const minutes = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 60_000);

export function renderIncident(inc) {
  return [
    `# ${inc.id}: ${inc.title}`, '',
    `- Severity: ${inc.severity}`, `- Status: ${inc.status}`, `- Affected services: ${inc.services.join(', ') || '-'}`,
    `- Opened: ${inc.openedAt}${inc.resolvedAt ? `\n- Resolved: ${inc.resolvedAt} (${minutes(inc.openedAt, inc.resolvedAt)} min)` : ''}`,
    ...(inc.rootCause ? [`- Root cause: ${inc.rootCause}`] : []),
    ...(inc.resolution ? [`- Resolution: ${inc.resolution}`] : []),
    '', inc.summary ? `${inc.summary}\n` : '',
    '## Timeline (UTC)', '',
    ...inc.timeline.map((e) => `- ${e.at} [${e.kind}] ${e.text.replace(/\n/g, '\n  ')}`), '',
  ].join('\n');
}

/** A blameless postmortem from the incident record and the sections given. */
export function renderPostmortem(inc, s) {
  const list = (v) => (Array.isArray(v) ? v.map((x) => `- ${typeof x === 'string' ? x : JSON.stringify(x)}`).join('\n') : String(v ?? '').trim() || '-');
  const actions = Array.isArray(s.action_items) && s.action_items.length
    ? ['| Action | Type | Owner | Priority | Due |', '|---|---|---|---|---|', ...s.action_items.map((a) => (typeof a === 'string' ? `| ${a} | - | - | - | - |` : `| ${a.action ?? '-'} | ${a.type ?? '-'} | ${a.owner ?? '-'} | ${a.priority ?? '-'} | ${a.due ?? '-'} |`))].join('\n')
    : '-';
  const rc = String(s.root_cause ?? inc.rootCause ?? '').trim();
  return [
    `# Postmortem: ${inc.title}`, '',
    `Incident ${inc.id}, ${inc.severity}, ${inc.openedAt} to ${inc.resolvedAt ?? 'ongoing'}${inc.resolvedAt ? ` (${minutes(inc.openedAt, inc.resolvedAt)} min)` : ''}. Blameless: this is about systems and processes, not people.`, '',
    '## Summary', '', String(s.summary ?? inc.summary ?? '').trim() || '-', '',
    '## Impact', '', list(s.impact), '',
    '## Timeline (UTC)', '', ...inc.timeline.map((e) => `- ${e.at} ${e.text.replace(/\n/g, ' ')}`), '',
    '## Root cause', '', rc ? (/^root cause:/i.test(rc) ? rc : `Root cause: ${rc}`) : 'Root cause: not established', '', ...(s.contributing_factors ? ['Contributing factors:', list(s.contributing_factors), ''] : []),
    '## Detection', '', list(s.detection), '',
    '## Resolution', '', String(s.resolution ?? inc.resolution ?? '').trim() || '-', '',
    '## What went well', '', list(s.went_well), '',
    '## What went wrong', '', list(s.went_wrong), '',
    '## Where we got lucky', '', list(s.lucky), '',
    '## Action items', '', actions, '',
    '## Evidence', '', list(s.evidence), '',
  ].join('\n');
}
