/**
 * The built-in plugins. Each declares a `ui` manifest validated with the same rules as any plugin's
 * (trust native: their components ship with the app) and contributes through the same registry.
 */

import type { BuiltinPlugin } from '../state/data';
import { coreChat } from './core.chat';
import { coreSettings } from './core.settings';
import { corePlugins } from './core.plugins';
import { coreActivity, coreInbox, coreProjects, coreShell } from './small';
import { coreArtifacts } from './core.artifacts';
import { coreAgents } from './core.agents';
import { coreDiagrams } from './diagrams';
import { coreDashboards } from './dashboards';

export const BUILTINS: BuiltinPlugin[] = [coreShell, coreChat, coreInbox, coreActivity, coreProjects, coreArtifacts, coreAgents, corePlugins, coreSettings, coreDiagrams, coreDashboards];
