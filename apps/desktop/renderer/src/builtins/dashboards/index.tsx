/**
 * core.dashboards: data, dashboards and reports. A built-in plugin like any other: its pages, panels,
 * commands, block actions ("Add to dashboard" on any chart in a transcript), tool renderers and
 * settings come through the same manifest a third-party plugin writes. The numbers come from the
 * server's engine; every change is an op the agents' tools apply too.
 */

import type { BuiltinPlugin } from '../../state/data';
import { openPluginPanel } from '../../state/app';
import { DocPage } from './Doc';
import { DataPage } from './Data';
import { Library } from './Library';
import { AskPanel, DashboardsCard, PinPanel, ToolResult } from './Panels';
import { listenData, useDataStore } from './api';

export const coreDashboards: BuiltinPlugin = {
  name: 'core.dashboards', version: '0.1.0', description: 'Data, dashboards and reports: sources, datasets, a semantic model, interactive dashboards, reports, publishing as live pages.',
  ui: {
    apiVersion: 1, displayName: 'Dashboards', icon: 'chart', trust: 'native', capabilities: [],
    contributes: {
      navItems: [
        { id: 'dashboards', title: 'Dashboards', icon: 'chart', view: 'dashboards', order: 40 },
        { id: 'reports', title: 'Reports', icon: 'file-text', view: 'reports', placement: 'more', order: 41 },
        { id: 'data', title: 'Data', icon: 'database', view: 'data', order: 42 },
      ],
      views: [
        { id: 'dashboards', title: 'Dashboards', kind: 'native', component: 'Dashboards' },
        { id: 'reports', title: 'Reports', kind: 'native', component: 'Reports' },
        { id: 'doc', title: 'Dashboard', kind: 'native', component: 'Doc' },
        { id: 'data', title: 'Data', kind: 'native', component: 'Data' },
      ],
      panels: [
        { id: 'ask', title: 'Ask the agent', icon: 'sparkles', kind: 'native', component: 'AskPanel', where: 'any' },
        { id: 'pin', title: 'Add to dashboard', icon: 'pin', kind: 'native', component: 'PinPanel', where: 'any' },
      ],
      commands: [
        { id: 'new-dashboard', title: 'New dashboard', category: 'Dashboards', icon: 'chart', action: { type: 'open-view', view: 'dashboards' } },
        { id: 'open-data', title: 'Data: sources, datasets, model', category: 'Dashboards', icon: 'database', action: { type: 'open-view', view: 'data' } },
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
  },
  components: { Dashboards: () => Library({ params: { type: 'dashboard' } }), Reports: () => Library({ params: { type: 'report' } }), Doc: DocPage, Data: DataPage, AskPanel, PinPanel, ToolResult, DashboardsCard },
  handlers: {
    pin: (args) => openPluginPanel('core.dashboards:pin', undefined, args),
  },
  activate: () => { listenData(); void useDataStore.getState().refreshDocs(); },
};
