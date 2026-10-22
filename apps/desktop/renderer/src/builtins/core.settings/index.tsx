/**
 * core.settings: the settings sections (each a contribution like any plugin's) and the commands that
 * open them; also the first-run steps for a provider key and a default model.
 */

import type { BuiltinPlugin } from '../../state/data';
import { useApp } from '../../state/app';
import { useData } from '../../state/data';
import { About, AboutPage, Appearance, Application, General, Servers, Shortcuts } from './app-sections';
import { Instructions, McpBundles, Memory, ModelsProviders, OnboardModel, OnboardProvider, Permissions, Schedules, Vault } from './server-sections';
import { SEARCH_TEXT } from '../../shell/Overlays';

Object.assign(SEARCH_TEXT, {
  'core.settings:appearance': 'theme light dark system accent colour contrast font size density width motion',
  'core.settings:general': 'send enter key steps model default mode notifications',
  'core.settings:application': 'login tray sleep engine restart log data folder home location move harness workspaces tmp scratch clean exports',
  'core.settings:models': 'provider key api deepseek anthropic claude openai moonshot kimi zai glm base url test delegation delegate other models sub-agents cost cap',
  'core.settings:permissions': 'allow deny ask rules limits steps cost minutes effective',
  'core.settings:instructions': 'claude.md instructions personal',
  'core.settings:memory': 'memory remember forget',
  'core.settings:vault': 'secret token key vault',
  'core.settings:schedules': 'cron schedule trigger later',
  'core.settings:mcp': 'mcp mcpb bundle extension server',
  'core.settings:shortcuts': 'keyboard keybinding shortcut chord',
  'core.settings:servers': 'remote server team sign in token local',
  'core.settings:about': 'version electron licence',
});

const open = (section: string) => () => useApp.getState().openSettings(`core.settings:${section}`);

export const coreSettings: BuiltinPlugin = {
  name: 'core.settings', version: '0.1.0', description: 'Settings: this machine, your account on the server, and every plugin\'s sections.',
  ui: {
    apiVersion: 1, displayName: 'Settings', icon: 'settings', trust: 'native', capabilities: [], required: true,
    contributes: {
      settings: [
        { id: 'appearance', title: 'Appearance', icon: 'palette', group: 'app', order: 1, scope: 'app', component: 'Appearance' },
        { id: 'general', title: 'General', icon: 'settings', group: 'app', order: 2, scope: 'app', component: 'General' },
        { id: 'application', title: 'Application', icon: 'monitor', group: 'app', order: 3, scope: 'app', component: 'Application' },
        { id: 'shortcuts', title: 'Shortcuts', icon: 'keyboard', group: 'app', order: 4, scope: 'app', component: 'Shortcuts' },
        { id: 'servers', title: 'Servers', icon: 'server', group: 'app', order: 5, scope: 'app', component: 'Servers' },
        { id: 'models', title: 'Models & providers', icon: 'cpu', group: 'agent', order: 1, scope: 'operator', component: 'ModelsProviders' },
        { id: 'permissions', title: 'Permissions & limits', icon: 'shield', group: 'agent', order: 2, scope: 'account', component: 'Permissions' },
        { id: 'instructions', title: 'Instructions', icon: 'book', group: 'agent', order: 3, scope: 'account', component: 'Instructions' },
        { id: 'memory', title: 'Memory', icon: 'memory', group: 'agent', order: 4, scope: 'account', component: 'Memory' },
        { id: 'vault', title: 'Vault', icon: 'vault', group: 'integrations', order: 1, scope: 'account', component: 'Vault' },
        { id: 'schedules', title: 'Schedules', icon: 'clock', group: 'integrations', order: 2, scope: 'account', component: 'Schedules' },
        { id: 'mcp', title: 'MCP bundles', icon: 'plug', group: 'integrations', order: 3, scope: 'operator', component: 'McpBundles' },
        { id: 'about', title: 'About', icon: 'info', group: 'admin', order: 99, scope: 'app', component: 'About' },
      ],
      views: [
        { id: 'about-page', title: 'About', kind: 'native', component: 'AboutPage' },
        { id: 'onboard-provider', title: 'Add a provider key', kind: 'native', component: 'OnboardProvider' },
        { id: 'onboard-model', title: 'Pick a default model', kind: 'native', component: 'OnboardModel' },
      ],
      commands: [
        {
          id: 'open', title: 'Open settings', category: 'Settings', icon: 'settings', keybinding: 'Mod+,', handler: 'open',
          agent: { description: 'Open Settings, at a section (a settings id from desktop_describe, e.g. core.settings:models).', inputSchema: { type: 'object', properties: { section: { type: 'string', maxLength: 140 } } } },
        },
        { id: 'about', title: 'About', category: 'Help', icon: 'info', action: { type: 'open-view', view: 'about-page' } },
        { id: 'models', title: 'Models & providers', category: 'Settings', icon: 'cpu', handler: 'models' },
        { id: 'appearance', title: 'Appearance', category: 'Settings', icon: 'palette', handler: 'appearance' },
        { id: 'shortcuts', title: 'Keyboard shortcuts', category: 'Settings', icon: 'keyboard', handler: 'shortcuts' },
        { id: 'engine', title: 'Engine status and log', category: 'Settings', icon: 'server', handler: 'engine' },
      ],
      onboarding: [
        { id: 'provider', title: 'Add a provider key', description: 'The engine calls models with your keys; they stay on the server.', view: 'onboard-provider', order: 10 },
        { id: 'model', title: 'Pick a default model', description: 'New conversations start with it; you can switch any time.', view: 'onboard-model', order: 20 },
      ],
    },
  },
  components: { Appearance, General, Application, Shortcuts, Servers, ModelsProviders, Permissions, Instructions, Memory, Vault, Schedules, McpBundles, About, AboutPage, OnboardProvider, OnboardModel },
  handlers: {
    open: (args) => {
      const section = typeof (args as { section?: unknown } | undefined)?.section === 'string' ? (args as { section: string }).section : '';
      if (!section) { useApp.getState().openSettings('core.settings:appearance'); return 'Settings are open.'; }
      const all = useData.getState().registry.settings.map((s) => s.qid);
      const qid = all.includes(section) ? section : all.find((s) => s.endsWith(`:${section}`));
      if (!qid) throw new Error(`No settings section ${section}. Sections: ${all.join(', ')}`);
      useApp.getState().openSettings(qid);
      return `Settings are open at ${qid}.`;
    },
    models: open('models'), appearance: open('appearance'), shortcuts: open('shortcuts'), engine: open('application'),
  },
};
