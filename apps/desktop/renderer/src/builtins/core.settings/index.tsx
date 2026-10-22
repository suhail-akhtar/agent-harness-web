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
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

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
  ...meta,
  ui,
  guide,
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
