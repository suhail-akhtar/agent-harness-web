/**
 * core.dashboards' manifest: plain data (no components), so tests read it as the app does. Its
 * guide for agents is GUIDE.md next to it (the skill core.dashboards-guide).
 */

export const meta = { name: 'core.dashboards', version: '0.1.0', description: 'Data, dashboards and reports: sources, datasets, a semantic model, interactive dashboards, reports, publishing as live pages.' };

export const ui = {
  apiVersion: 1, displayName: 'Dashboards', icon: 'chart', trust: 'native', capabilities: [],
  menu: { title: 'Dashboards', icon: 'chart', order: 30, items: ['dashboards', 'reports', 'data'] },
  home: 'home',
  guide: 'GUIDE.md',
  // The engine's data tools (the server's DATA_TOOLS): what agents build and change dashboards with.
  tools: ['datasource', 'dataset', 'model', 'dashboard'],
  contributes: {
    navItems: [
      { id: 'dashboards', title: 'Dashboards', icon: 'chart', view: 'dashboards', order: 40 },
      { id: 'reports', title: 'Reports', icon: 'file-text', view: 'reports', placement: 'more', order: 41 },
      { id: 'data', title: 'Data', icon: 'database', view: 'data', order: 42 },
    ],
    views: [
      { id: 'home', title: 'Dashboards', icon: 'chart', description: 'Recent dashboards and reports, datasets, sources and templates.', kind: 'native', component: 'Home' },
      { id: 'dashboards', title: 'Dashboards', description: 'Every dashboard: search, new, from a template.', kind: 'native', component: 'Dashboards' },
      { id: 'reports', title: 'Reports', description: 'Documents with live numbers: prose and visuals, snapshots, print.', kind: 'native', component: 'Reports' },
      { id: 'doc', title: 'Dashboard', description: 'One dashboard or report (params: id; page; edit "1").', kind: 'native', component: 'Doc' },
      { id: 'data', title: 'Data', description: 'Sources, datasets (the query editor), the semantic model, refresh history (params: tab = sources, datasets, model or history; dataset).', kind: 'native', component: 'Data' },
    ],
    panels: [
      { id: 'ask', title: 'Ask the agent', icon: 'sparkles', kind: 'native', component: 'AskPanel', where: 'any' },
      { id: 'pin', title: 'Add to dashboard', icon: 'pin', kind: 'native', component: 'PinPanel', where: 'any' },
    ],
    commands: [
      { id: 'new-dashboard', title: 'New dashboard', category: 'Dashboards', icon: 'chart', action: { type: 'open-view', view: 'dashboards' }, agent: { description: 'Opens the Dashboards page (every dashboard; New and From a template are there). Build one yourself with the dashboard tool.' } },
      { id: 'open-doc', title: 'Open a dashboard or report…', category: 'Dashboards', icon: 'chart', action: { type: 'open-view', view: 'doc' }, agent: { description: 'Shows a dashboard or report in the app (its id from the dashboard tool), optionally at a page or in edit mode.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The document id, as the dashboard tool gives it', maxLength: 80 }, page: { type: 'string', description: 'A page id or name', maxLength: 80 }, edit: { type: 'string', enum: ['1'], description: '"1" opens it for editing' } }, required: ['id'] } } },
      { id: 'open-data', title: 'Data: sources, datasets, model', category: 'Dashboards', icon: 'database', action: { type: 'open-view', view: 'data' }, agent: { description: 'Opens the Data page at a tab: sources, datasets (optionally one dataset), model or history.', inputSchema: { type: 'object', properties: { tab: { type: 'string', enum: ['sources', 'datasets', 'model', 'history'] }, dataset: { type: 'string', maxLength: 80 } } } } },
      { id: 'pin', title: 'Add to dashboard…', category: 'Dashboards', icon: 'pin', handler: 'pin' },
    ],
    blockActions: [{ id: 'pin', title: 'Add to dashboard', icon: 'pin', kinds: ['chart', 'viz', 'table', 'csv', 'tsv', 'json', 'dashboard'], command: 'pin' }],
    renderers: ['dashboard', 'dataset', 'model', 'datasource'].map((t) => ({ id: `tool-${t}`, for: { tool: t }, kind: 'native', component: 'ToolResult' })),
    homeCards: [{ id: 'top', title: 'Dashboards', kind: 'native', component: 'DashboardsCard', order: 30 }],
    settings: [{
      id: 'dashboards', title: 'Dashboards', icon: 'chart', group: 'plugins', scope: 'app',
      schema: { type: 'object', properties: {
        previewRows: { type: 'number', title: 'Rows in previews', default: 200, minimum: 10, maximum: 5000 },
        defaultRefresh: { type: 'string', title: 'New dashboards refresh', enum: ['manual', 'hourly', 'daily'], default: 'manual' },
        publishAccess: { type: 'string', title: 'Publish to', enum: ['token', 'signed-in'], default: 'token', description: 'Anyone with the link, or signed-in accounts of this server' },
        publishSql: { type: 'boolean', title: 'Let viewers see the SQL', default: false },
      } },
    }],
    prompts: [{ id: 'build', title: 'Build a dashboard from a file', prompt: 'Build a dashboard from ', icon: 'chart', home: true }],
  },
};
