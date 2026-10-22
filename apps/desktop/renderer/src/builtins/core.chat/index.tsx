/**
 * core.chat: home, conversations, search. A built-in plugin: everything below is contributed through
 * the same manifest a third-party plugin writes (trust native: its components ship with the app).
 */

import type { BuiltinPlugin } from '../../state/data';
import { Home, RecentCard, Search, Session } from './Views';
import { navigate, prefill, useApp } from '../../state/app';
import { meta, ui } from './manifest';
import guide from './GUIDE.md?raw';

export const coreChat: BuiltinPlugin = {
  ...meta,
  ui,
  guide,
  components: { Home, Session, Search, RecentCard },
  handlers: {
    newChat: (args) => {
      const prompt = typeof (args as { prompt?: unknown } | undefined)?.prompt === 'string' ? (args as { prompt: string }).prompt : '';
      if (prompt) prefill(prompt, true); else navigate({ view: 'core.chat:home' });
      return prompt ? 'A new chat is open with the prompt typed in; the person sends it.' : 'A new chat is open.';
    },
    workflow: () => {
      const r = useApp.getState().route;
      useApp.setState({ workflowDialog: { sessionId: r.view === 'core.chat:session' ? r.params?.id : undefined } });
    },
  },
};
