/**
 * The runtime React artifacts run with, served from harness://preview/runtime/ into a sandboxed
 * frame (opaque origin, no network). It carries React, ReactDOM and a JSX/TypeScript transform
 * (sucrase); the artifact's code is transformed here and run as an inline script (the preview CSP
 * allows inline script, never eval). Only react and react-dom can be imported.
 */

import * as React from 'react';
import * as ReactDOMClient from 'react-dom/client';
import { transform } from 'sucrase';

type Mod = { exports: Record<string, unknown> & { default?: unknown } };
const MODULES: Record<string, unknown> = { react: React, 'react-dom': ReactDOMClient, 'react-dom/client': ReactDOMClient };

function show(root: HTMLElement, title: string, detail: string) {
  root.innerHTML = '';
  const box = document.createElement('div');
  box.setAttribute('style', 'font:13px/1.5 system-ui,sans-serif;color:#b42318;background:#fff4f2;border:1px solid #f3c3bb;border-radius:8px;padding:10px 12px;white-space:pre-wrap');
  box.textContent = `${title}\n${detail}`;
  root.appendChild(box);
}

const w = window as unknown as Record<string, unknown>;
w.React = React;
w.__harnessRequire = (name: string) => {
  if (Object.hasOwn(MODULES, name)) return MODULES[name];
  throw new Error(`"${name}" is not available in previews (only react and react-dom).`);
};

w.HarnessArtifact = {
  mount(code: string, root: HTMLElement) {
    let out: string;
    try { out = transform(code, { transforms: ['jsx', 'typescript', 'imports'], jsxRuntime: 'classic', production: true }).code; }
    catch (e) { show(root, 'This component does not compile:', (e as Error).message); return; }
    const mod: Mod = { exports: {} };
    w.__harnessModule = mod;
    w.__harnessDone = (err?: unknown) => {
      if (err) { show(root, 'This component failed:', String((err as Error)?.message ?? err)); return; }
      const C = (mod.exports.default ?? Object.values(mod.exports).find((v) => typeof v === 'function')) as React.ComponentType | undefined;
      if (typeof C !== 'function') { show(root, 'Nothing to show:', 'the code exports no component (export default function App() {...}).'); return; }
      try { ReactDOMClient.createRoot(root).render(React.createElement(Boundary, null, React.createElement(C))); }
      catch (e) { show(root, 'This component failed:', (e as Error).message); }
    };
    const s = document.createElement('script');
    s.textContent = `(function(require, module, exports, React){try{\n${out}\n;window.__harnessDone();}catch(e){window.__harnessDone(e);}})(window.__harnessRequire, window.__harnessModule, window.__harnessModule.exports, window.React);`;
    document.body.appendChild(s);
  },
};

class Boundary extends React.Component<{ children?: React.ReactNode }, { error?: string }> {
  override state: { error?: string } = {};
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) }; }
  override render() { return this.state.error ? React.createElement('pre', { style: { color: '#b42318', whiteSpace: 'pre-wrap', font: '13px system-ui' } }, `This component failed: ${this.state.error}`) : this.props.children; }
}
