/**
 * Right-click menus for the whole app, drawn in its own style.
 *
 * What the pointer is on offers its own actions first: a component passes them with
 * `onContextMenu={contextItems(() => items, 'Conversation')}` (the same items as its "..." menu), inner
 * ones before outer ones. Then what every page has: the word under the pointer's spelling, a selection
 * (copy, ask about it in the chat, search for it), a link (open, copy), an image (copy, save), a code
 * block (copy the code), and the editing commands in a text field (undo, redo, cut, copy, paste, paste as
 * plain text, select all). Plugin frames get the standard menu from main (electron/edit.ts).
 */

import React, { useEffect, useState } from 'react';
import { MenuList, Popover, toast, type MenuItem } from '@harness/ui';
import { desktop } from '../bridge';
import { useApp, navigate } from '../state/app';

type Provided = { heading?: string; items: () => MenuItem[] };
const KEY = '__hxContext';

/** A component's own items for a right-click on it (or inside it). */
export function contextItems(items: () => MenuItem[], heading?: string): (e: React.MouseEvent) => void {
  return (e) => {
    const ev = e.nativeEvent as MouseEvent & { [KEY]?: Provided[] };
    (ev[KEY] ??= []).push({ heading, items });
  };
}

const sep = (id: string): MenuItem => ({ id, label: '', separator: true });
const mod = navigator.platform.toLowerCase().includes('mac') ? 'Cmd' : 'Ctrl';

/** Puts text into the open conversation's composer, quoted (core.chat listens). */
export function quoteInComposer(text: string): void {
  window.dispatchEvent(new CustomEvent('hx:compose', { detail: { text: text.split('\n').map((l) => `> ${l}`).join('\n') + '\n\n' } }));
}

function editable(el: Element | null): HTMLElement | null {
  const x = el?.closest('input, textarea, [contenteditable=""], [contenteditable="true"]') as HTMLElement | null;
  if (!x) return null;
  if (x instanceof HTMLInputElement && !['text', 'search', 'url', 'email', 'tel', 'password', 'number', ''].includes(x.type)) return null;
  return x;
}

function build(ev: MouseEvent & { [KEY]?: Provided[] }, spelling: { word: string; suggestions: string[] } | null): MenuItem[] {
  const target = ev.target instanceof Element ? ev.target : null;
  const out: MenuItem[] = [];
  const add = (items: MenuItem[], heading?: string) => {
    const real = items.filter((i) => !i.separator || i.id);
    if (!real.length) return;
    if (out.length) out.push(sep(`s${out.length}`));
    if (heading) out.push({ id: `h${out.length}`, label: heading, section: true });
    out.push(...real);
  };
  const field = editable(target);
  // The word under the pointer, misspelled: its suggestions first.
  if (field && spelling) {
    add([
      ...spelling.suggestions.map((s) => ({ id: `spell:${s}`, label: s, onSelect: () => void desktop.edit.replaceMisspelling(s) })),
      ...(spelling.suggestions.length ? [] : [{ id: 'spell:none', label: 'No suggestions', disabled: true }]),
      { id: 'spell:add', label: `Add “${spelling.word}” to the dictionary`, icon: 'plus', onSelect: () => void desktop.edit.addToDictionary(spelling.word) },
    ]);
  }
  for (const p of ev[KEY] ?? []) add(p.items(), p.heading);
  const selection = window.getSelection()?.toString().trim() ?? '';
  const link = target?.closest('a[href]') as HTMLAnchorElement | null;
  const img = target?.closest('img') as HTMLImageElement | null;
  const code = target?.closest('pre') as HTMLElement | null;
  if (link) {
    const href = link.getAttribute('href') ?? '';
    const external = /^(https?:|mailto:)/i.test(link.href);
    add([
      ...(external ? [{ id: 'link:open', label: 'Open link in browser', icon: 'external', onSelect: () => void desktop.openExternal(link.href) }] : []),
      { id: 'link:copy', label: external ? 'Copy link address' : 'Copy link', icon: 'link', onSelect: () => void desktop.clipboard(external ? link.href : href) },
    ]);
  }
  if (img?.src) {
    add([
      { id: 'img:copy', label: 'Copy image', icon: 'copy', onSelect: () => void desktop.edit.copyImageAt(ev.clientX, ev.clientY) },
      { id: 'img:save', label: 'Save image as…', icon: 'download', onSelect: () => void desktop.edit.saveImage(img.src).catch((e: Error) => toast(e.message, { kind: 'error' })) },
      ...(/^https?:/i.test(img.src) ? [{ id: 'img:open', label: 'Open image in browser', icon: 'external', onSelect: () => void desktop.openExternal(img.src) }] : []),
    ]);
  }
  if (code && !field) add([{ id: 'code:copy', label: 'Copy code', icon: 'code', onSelect: () => void desktop.clipboard((code.querySelector('code') ?? code).innerText).then(() => toast('Code copied')) }]);
  if (field) {
    const ro = (field as HTMLInputElement).readOnly || (field as HTMLInputElement).disabled;
    const sel = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? (field.selectionEnd ?? 0) - (field.selectionStart ?? 0) > 0 : !!selection;
    const secret = field instanceof HTMLInputElement && field.type === 'password';
    // The menu took the focus: the field gets it back (its selection kept) before the command runs in it.
    const run = (what: Parameters<typeof desktop.edit.do>[0]) => () => { field.focus({ preventScroll: true }); setTimeout(() => void desktop.edit.do(what), 0); };
    add([
      { id: 'edit:undo', label: 'Undo', icon: 'arrow-left', shortcut: `${mod}+Z`, disabled: ro, onSelect: run('undo') },
      { id: 'edit:redo', label: 'Redo', icon: 'arrow-right', shortcut: `${mod}+Y`, disabled: ro, onSelect: run('redo') },
      sep('edit:s1'),
      { id: 'edit:cut', label: 'Cut', shortcut: `${mod}+X`, disabled: ro || !sel || secret, onSelect: run('cut') },
      { id: 'edit:copy', label: 'Copy', icon: 'copy', shortcut: `${mod}+C`, disabled: !sel || secret, onSelect: run('copy') },
      { id: 'edit:paste', label: 'Paste', shortcut: `${mod}+V`, disabled: ro, onSelect: run('paste') },
      { id: 'edit:plain', label: 'Paste as plain text', shortcut: `${mod}+Shift+V`, disabled: ro, onSelect: run('pasteAndMatchStyle') },
      sep('edit:s2'),
      { id: 'edit:all', label: 'Select all', shortcut: `${mod}+A`, onSelect: run('selectAll') },
    ]);
  } else if (selection) {
    const short = selection.length > 28 ? `${selection.slice(0, 26)}…` : selection;
    const inChat = useApp.getState().route.view === 'core.chat:session';
    add([
      { id: 'sel:copy', label: 'Copy', icon: 'copy', shortcut: `${mod}+C`, onSelect: () => void desktop.clipboard(selection) },
      ...(inChat ? [{ id: 'sel:quote', label: 'Ask about this in the chat', icon: 'chat', onSelect: () => quoteInComposer(selection) }] : []),
      { id: 'sel:search', label: `Search conversations for “${short}”`, icon: 'search', onSelect: () => navigate({ view: 'core.chat:search', params: { q: selection.slice(0, 200) } }) },
    ]);
  }
  // Nothing else here: where to go and the command palette.
  if (!out.length) {
    add([
      { id: 'nav:back', label: 'Back', icon: 'arrow-left', shortcut: 'Alt+Left', onSelect: () => history.back() },
      { id: 'nav:forward', label: 'Forward', icon: 'arrow-right', shortcut: 'Alt+Right', onSelect: () => history.forward() },
      sep('nav:s'),
      { id: 'nav:palette', label: 'Command palette…', icon: 'command', shortcut: `${mod}+K`, onSelect: () => useApp.setState({ paletteOpen: true } as never) },
      { id: 'nav:new', label: 'New chat', icon: 'edit', onSelect: () => navigate({ view: 'core.chat:home' }) },
    ]);
  }
  return out;
}

export function ContextMenuHost(): React.ReactElement | null {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  useEffect(() => {
    const on = (ev: MouseEvent) => {
      // Shift+right-click keeps the plain browser menu out of the way: nothing to do here then either.
      if (ev.defaultPrevented && !(ev as MouseEvent & { [KEY]?: Provided[] })[KEY]) return;
      ev.preventDefault();
      const at = { x: ev.clientX, y: ev.clientY };
      const show = (spelling: { word: string; suggestions: string[] } | null) => {
        const items = build(ev as MouseEvent & { [KEY]?: Provided[] }, spelling);
        setMenu(items.length ? { ...at, items } : null);
      };
      // The spelling of the word under the pointer comes from main, a moment after the click.
      if (editable(ev.target instanceof Element ? ev.target : null)) {
        void new Promise((r) => setTimeout(r, 30)).then(() => desktop.edit.spelling()).then(show, () => show(null));
      } else show(null);
    };
    window.addEventListener('contextmenu', on);
    return () => window.removeEventListener('contextmenu', on);
  }, []);
  if (!menu) return null;
  const anchor = { getBoundingClientRect: () => new DOMRect(menu.x, menu.y, 0, 0) };
  return (
    <Popover open onClose={() => setMenu(null)} anchor={anchor} placement="bottom-start" role="presentation" className="min-w-[220px] max-w-[340px]" label="Context menu">
      <div data-context-menu><MenuList items={menu.items} onDone={() => setMenu(null)} /></div>
    </Popover>
  );
}
