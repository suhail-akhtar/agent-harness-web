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
import { DashboardsHome } from './Home';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreDashboards: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { Home: DashboardsHome, Dashboards: () => Library({ params: { type: 'dashboard' } }), Reports: () => Library({ params: { type: 'report' } }), Doc: DocPage, Data: DataPage, AskPanel, PinPanel, ToolResult, DashboardsCard },
  handlers: {
    pin: (args) => openPluginPanel('core.dashboards:pin', undefined, args),
  },
  activate: () => { listenData(); void useDataStore.getState().refreshDocs(); },
};
