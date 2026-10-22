/**
 * The composer: a growing text box with the model picker (with effort), the permission mode, Think,
 * attachments (pick, paste, drop), "@" to mention a file, "/" for slash commands (the registry's,
 * plugins' included, and the server's own like /compact), plugins' composer chips, and drafts kept
 * per conversation. While the agent works, Enter steers (the message joins the running turn) and
 * "Queue" holds it until the turn ends.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Attachment, Effort, Mode, ModelInfo } from '@harness/client';
import { Button, Icon, IconButton, MenuList, Popover, Tooltip, cx, toast, type MenuItem } from '@harness/ui';
import { useData, client } from '../../state/data';
import { useApp } from '../../state/app';
import { runAction } from '../../registry/actions';
import { desktop, platform } from '../../bridge';
import { formatChord } from '../../registry/keybindings';

export interface ComposerValue { model: string; effort?: Effort; mode: Mode; think: boolean }
export interface ComposerProps {
  draftKey: string;
  value: ComposerValue;
  onChange: (v: Partial<ComposerValue>) => void;
  onSend: (text: string, attachments: Attachment[], how: 'send' | 'queue') => Promise<boolean> | boolean;
  running?: boolean;
  onStop?: () => void;
  /** For "@": the conversation whose files to search. */
  sessionId?: string;
  placeholder?: string;
  queued?: string[];
  onUnqueue?: (i: number) => void;
  autoFocus?: boolean;
  left?: React.ReactNode;
}

export const MODE_LABEL: Record<Mode, { label: string; hint: string; icon: string }> = {
  default: { label: 'Ask first', hint: 'Asks before edits and commands', icon: 'shield' },
  acceptEdits: { label: 'Accept edits', hint: 'Edits go ahead; commands ask', icon: 'edit' },
  plan: { label: 'Plan first', hint: 'Proposes a plan before acting', icon: 'list' },
  auto: { label: 'Auto', hint: 'A small model checks each call', icon: 'sparkles' },
  dontAsk: { label: "Don't ask", hint: 'Refuses what would need asking', icon: 'lock' },
  bypass: { label: 'Bypass', hint: 'No checks at all (careful)', icon: 'zap' },
};

interface Pending { name: string; mediaType: string; base64: string; size: number }
const readFile = (f: File) => new Promise<Pending>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve({ name: f.name, mediaType: f.type || 'application/octet-stream', base64: String(r.result).split(',')[1] ?? '', size: f.size }); r.onerror = () => reject(r.error); r.readAsDataURL(f); });
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json' };

export function Composer(p: ComposerProps): React.ReactElement {
  const prefs = useApp((s) => s.prefs);
  const prefillReq = useApp((s) => s.prefill);
  const registry = useData((s) => s.registry);
  const [text, setText] = useState(() => { try { return localStorage.getItem(`draft:${p.draftKey}`) ?? ''; } catch { return ''; } });
  const [files, setFiles] = useState<Pending[]>([]);
  const [menu, setMenu] = useState<null | { kind: '@' | '/'; query: string; start: number }>(null);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [active, setActive] = useState(0);
  const [sending, setSending] = useState(false);
  const [drag, setDrag] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const wrap = useRef<HTMLDivElement>(null);

  // Drafts survive switching conversations and restarts.
  useEffect(() => { try { if (text) localStorage.setItem(`draft:${p.draftKey}`, text); else localStorage.removeItem(`draft:${p.draftKey}`); } catch { /* none */ } }, [text, p.draftKey]);
  useEffect(() => { try { setText(localStorage.getItem(`draft:${p.draftKey}`) ?? ''); } catch { /* none */ } setFiles([]); }, [p.draftKey]);
  useEffect(() => { if (prefillReq) { setText(prefillReq.text); useApp.setState({ prefill: null }); setTimeout(() => box.current?.focus(), 0); } }, [prefillReq]);
  useEffect(() => { const el = box.current; if (!el) return; el.style.height = 'auto'; el.style.height = `${Math.min(280, el.scrollHeight)}px`; }, [text]);
  useEffect(() => { if (p.autoFocus) box.current?.focus(); }, [p.autoFocus, p.draftKey]);

  // "@" files and "/" commands.
  useEffect(() => {
    if (!menu) { setMenuItems([]); return; }
    let alive = true;
    if (menu.kind === '/') {
      const q = menu.query.toLowerCase();
      const fromRegistry = registry.slashCommands.filter((s) => s.name.startsWith(q)).map((s): MenuItem => ({ id: `r:${s.name}`, label: `/${s.name}`, hint: s.description, icon: 'command', onSelect: () => pickSlash(s.name) }));
      const server: MenuItem[] = [{ id: 's:compact', label: '/compact', hint: 'Compact the context now', icon: 'layers', onSelect: () => replaceToken('/compact ') }].filter((x) => x.label.slice(1).startsWith(q));
      setMenuItems([...fromRegistry, ...server]);
      setActive(0);
      return;
    }
    if (!p.sessionId) { setMenuItems([{ id: 'none', label: 'Files can be mentioned once the conversation has started', disabled: true }]); return; }
    const t = setTimeout(() => {
      client.files.search(p.sessionId!, menu.query || '.', false, 30).then((r) => {
        if (!alive) return;
        const items = r.results.slice(0, 30).map((h): MenuItem => ({ id: `f:${h.path}`, label: h.path, icon: 'file', onSelect: () => replaceToken(`@${h.path} `) }));
        setMenuItems(items.length ? items : [{ id: 'none', label: 'No matching files', disabled: true }]);
        setActive(0);
      }).catch(() => alive && setMenuItems([{ id: 'none', label: 'Files are not available for this conversation', disabled: true }]));
    }, 120);
    return () => { alive = false; clearTimeout(t); };
  }, [menu?.kind, menu?.query, registry, p.sessionId]);

  const replaceToken = (insert: string) => {
    if (!menu) return;
    const end = box.current?.selectionStart ?? text.length;
    const next = text.slice(0, menu.start) + insert + text.slice(end);
    setText(next);
    setMenu(null);
    setTimeout(() => { const pos = menu.start + insert.length; box.current?.focus(); box.current?.setSelectionRange(pos, pos); }, 0);
  };
  const pickSlash = (name: string) => {
    const s = registry.slashCommands.find((x) => x.name === name);
    if (!s) return;
    const rest = text.slice((box.current?.selectionStart ?? text.length)).trim();
    setMenu(null);
    if (s.action.type === 'prompt') { setText(s.action.prompt.replace(/\{args\}/g, rest).trim()); setTimeout(() => box.current?.focus(), 0); return; }
    setText('');
    void runAction(s.action, s.plugin, rest);
  };

  const onInput = (v: string, caret: number) => {
    setText(v);
    const before = v.slice(0, caret);
    const slash = /^\/([a-z0-9-]*)$/.exec(before);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (slash) setMenu({ kind: '/', query: slash[1]!, start: 0 });
    else if (at) setMenu({ kind: '@', query: at[2]!, start: caret - at[2]!.length - 1 });
    else setMenu(null);
  };

  const send = async (how: 'send' | 'queue') => {
    const t = text.trim();
    if (!t && !files.length) return;
    // A typed registry slash command runs its action (prompt actions expand first, never sent unseen).
    const m = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(t);
    const slash = m ? registry.slashCommands.find((s) => s.name === m[1]) : undefined;
    if (slash) {
      if (slash.action.type === 'prompt') { setText(slash.action.prompt.replace(/\{args\}/g, m![2] ?? '').trim()); return; }
      setText('');
      await runAction(slash.action, slash.plugin, m![2] ?? '');
      return;
    }
    setSending(true);
    try {
      const ok = await p.onSend(t, files.map(({ name, mediaType, base64 }) => ({ name, mediaType, base64 })), how);
      if (ok) { setText(''); setFiles([]); }
    } finally { setSending(false); }
  };

  const addFiles = async (list: File[]) => {
    const total = [...files.map((f) => f.size), ...list.map((f) => f.size)].reduce((a, b) => a + b, 0);
    if (files.length + list.length > 10) { toast('At most 10 attachments', { kind: 'warning' }); return; }
    if (total > 20 * 1024 * 1024) { toast('Attachments are limited to 20 MB in all', { kind: 'warning' }); return; }
    try { const read = await Promise.all(list.map(readFile)); setFiles((f) => [...f, ...read]); } catch (e) { toast((e as Error).message, { kind: 'error' }); }
  };
  const pickFiles = async () => {
    try {
      const picked = await desktop.openFiles();
      setFiles((f) => [...f, ...picked.map((x) => ({ name: x.name, base64: x.base64, size: x.size, mediaType: MIME[x.name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream' }))].slice(0, 10));
    } catch {
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true;
      input.onchange = () => void addFiles([...(input.files ?? [])]);
      input.click();
    }
  };

  const sendKeyMod = prefs.sendKey === 'mod-enter';
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menu && menuItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(menuItems.length - 1, a + 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { const it = menuItems[active]; if (it && !it.disabled) { e.preventDefault(); it.onSelect?.(); return; } }
      if (e.key === 'Escape') { e.preventDefault(); setMenu(null); return; }
    }
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      const mod = e.ctrlKey || e.metaKey;
      if (e.altKey && p.running) { e.preventDefault(); void send('queue'); return; }
      if (sendKeyMod ? mod : !e.shiftKey && !mod) { e.preventDefault(); void send('send'); }
    }
    if (e.key === 'Escape' && p.running && p.onStop && !text) { e.preventDefault(); p.onStop(); }
  };

  const chips = registry.composerChips;
  return (
    <div className="mx-auto w-full max-w-column px-4 pb-3 sm:px-6" data-composer>
      {p.queued?.length ? (
        <div className="mb-1.5 flex flex-wrap gap-1.5" data-queue>
          {p.queued.map((q, i) => <span key={i} className="inline-flex max-w-full items-center gap-1 rounded-lg bg-hx-pill py-1 pl-2 pr-1 text-[12px] text-hx-secondary"><Icon name="clock" size={12} /><span className="max-w-[320px] truncate">Queued: {q}</span><button type="button" aria-label="Remove from the queue" onClick={() => p.onUnqueue?.(i)} className="rounded p-0.5 hover:bg-hx-hover"><Icon name="x" size={12} /></button></span>)}
        </div>
      ) : null}
      <div ref={wrap} className={cx('relative rounded-2xl border bg-hx-elevated shadow-sm transition-colors focus-within:border-hx-border', drag ? 'border-hx-accent' : 'border-hx-border-subtle')}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrag(true); } }} onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); void addFiles([...e.dataTransfer.files]); }}>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-1.5 px-3 pt-3" data-attachments>
            {files.map((f, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-hx-border-subtle bg-hx-bg py-1 pl-1 pr-1.5 text-[12px]">
                {f.mediaType.startsWith('image/') ? <img src={`data:${f.mediaType};base64,${f.base64}`} alt="" className="h-7 w-7 rounded object-cover" /> : <Icon name="file" size={14} className="ml-1 text-hx-muted" />}
                <span className="max-w-[160px] truncate">{f.name}</span>
                <button type="button" aria-label={`Remove ${f.name}`} onClick={() => setFiles((x) => x.filter((_, j) => j !== i))} className="text-hx-muted hover:text-hx-danger"><Icon name="x" size={12} /></button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          value={text}
          rows={1}
          aria-label="Message"
          data-composer-input
          placeholder={p.placeholder ?? (p.running ? 'Steer the agent, or queue a message…' : 'Ask anything. @ to mention a file, / for commands')}
          onChange={(e) => onInput(e.target.value, e.target.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => { const imgs = [...e.clipboardData.files]; if (imgs.length) { e.preventDefault(); void addFiles(imgs); } }}
          className="block max-h-[280px] min-h-[52px] w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-[14.5px] leading-6 text-hx-primary outline-none placeholder:text-hx-muted"
        />
        <Popover open={!!menu && menuItems.length > 0} onClose={() => setMenu(null)} anchor={wrap} placement="top-start" noFocus className="w-[min(440px,90vw)]" role="listbox" label={menu?.kind === '/' ? 'Commands' : 'Files'}>
          <MenuList items={menuItems} activeIndex={active} onActiveIndex={setActive} onDone={() => setMenu(null)} />
        </Popover>
        <div className="flex flex-wrap items-center gap-1 px-2 pb-2">
          <IconButton icon="paperclip" size="sm" label="Attach files" onClick={() => void pickFiles()} />
          {p.left}
          <ModelPicker value={p.value} onChange={p.onChange} />
          <ModeChip value={p.value.mode} onChange={(mode) => p.onChange({ mode })} />
          <Tooltip label={p.value.think ? 'Thinking harder on (effort high)' : 'Think harder'}>
            <button type="button" data-chip="think" aria-pressed={p.value.think} onClick={() => p.onChange({ think: !p.value.think })} className={cx('inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px]', p.value.think ? 'bg-hx-accent-soft text-hx-accent-text' : 'text-hx-muted hover:bg-hx-hover hover:text-hx-primary')}><Icon name="brain" size={14} />Think</button>
          </Tooltip>
          {chips.map((c) => <PluginChip key={c.qid} chip={c} />)}
          <div className="flex-1" />
          {p.running && <Button size="sm" variant="ghost" icon="clock" disabled={!text.trim()} onClick={() => void send('queue')} title={`Queue it for when the agent is done (${formatChord('Alt+Enter', platform)})`}>Queue</Button>}
          {p.running && p.onStop && <IconButton icon="stop" size="sm" label="Stop" tone="danger" onClick={p.onStop} data-stop />}
          <Tooltip label={p.running ? 'Send now: joins the running turn' : 'Send'} shortcut={sendKeyMod ? formatChord('Mod+Enter', platform) : 'Enter'}>
            <button type="button" aria-label={p.running ? 'Steer' : 'Send'} data-send disabled={sending || (!text.trim() && !files.length)} onClick={() => void send('send')}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-hx-accent text-hx-on-accent transition-opacity disabled:opacity-35">
              <Icon name="arrow-up" size={17} strokeWidth={2.2} />
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

const EFFORT_LABEL: Record<Effort, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' };

export function ModelPicker({ value, onChange }: { value: ComposerValue; onChange: (v: Partial<ComposerValue>) => void }): React.ReactElement {
  const models = useData((s) => s.models);
  const providers = useData((s) => s.providers);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const current = models.find((m) => m.id === value.model);
  const groups = useMemo(() => {
    const by = new Map<string, ModelInfo[]>();
    for (const m of models) by.set(m.provider, [...(by.get(m.provider) ?? []), m]);
    return [...by.entries()].sort((a, b) => Number(b[1].some((m) => m.available)) - Number(a[1].some((m) => m.available)));
  }, [models]);
  const effort = value.effort ?? current?.effort;
  return (
    <>
      <button ref={ref} type="button" data-model-picker onClick={() => setOpen(!open)} className="inline-flex h-7 max-w-[220px] items-center gap-1 rounded-lg px-2 text-[12.5px] text-hx-secondary hover:bg-hx-hover hover:text-hx-primary">
        <Icon name="cpu" size={14} /><span className="truncate">{current?.label ?? (value.model || 'Choose a model')}</span>{effort && current?.efforts && current.efforts.length > 1 && <span className="text-hx-muted">· {EFFORT_LABEL[effort]}</span>}<Icon name="chevron-down" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top-start" className="w-[340px]" label="Models">
        <div className="hx-scroll max-h-[360px] overflow-y-auto" data-model-list>
          {groups.map(([prov, list]) => (
            <div key={prov}>
              <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-hx-muted">{providers?.find((p) => p.id === prov)?.label ?? prov}</div>
              {list.map((m) => (
                <button key={m.id} type="button" data-model={m.id} disabled={!m.available} onClick={() => { onChange({ model: m.id, effort: m.effort }); setOpen(false); }}
                  className={cx('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px]', m.id === value.model ? 'bg-hx-active' : 'hover:bg-hx-hover', !m.available && 'opacity-50')}>
                  <span className="min-w-0 flex-1"><span className="block truncate">{m.label}</span><span className="block truncate text-[11px] text-hx-muted">{m.available ? `${Math.round(m.contextWindow / 1000)}K context${m.vision ? ' · images' : ''}` : 'No key: add one in Settings'}</span></span>
                  {m.id === value.model && <Icon name="check" size={14} className="text-hx-accent-text" />}
                </button>
              ))}
            </div>
          ))}
          {!models.length && <div className="p-3 text-[12.5px] text-hx-muted">No models yet: the engine is starting.</div>}
        </div>
        {current && current.efforts.length > 1 && (
          <div className="border-t border-hx-border-subtle p-2">
            <div className="mb-1 px-1 text-[11px] font-medium uppercase tracking-wide text-hx-muted">Effort</div>
            <div className="flex flex-wrap gap-1" data-effort>
              {current.efforts.map((e) => <button key={e} type="button" data-effort-option={e} onClick={() => onChange({ effort: e })} className={cx('rounded-md px-2 py-1 text-[12px]', e === effort ? 'bg-hx-accent text-hx-on-accent' : 'bg-hx-pill text-hx-secondary hover:bg-hx-active')}>{EFFORT_LABEL[e]}</button>)}
            </div>
          </div>
        )}
        <button type="button" onClick={() => { setOpen(false); useApp.getState().openSettings('core.settings:models'); }} className="mt-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12.5px] text-hx-muted hover:bg-hx-hover hover:text-hx-primary"><Icon name="key" size={13} />Models & providers…</button>
      </Popover>
    </>
  );
}

function ModeChip({ value, onChange }: { value: Mode; onChange: (m: Mode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const m = MODE_LABEL[value] ?? MODE_LABEL.default;
  return (
    <>
      <button ref={ref} type="button" data-chip="mode" onClick={() => setOpen(!open)} className={cx('inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px] hover:bg-hx-hover', value === 'bypass' ? 'text-hx-danger' : 'text-hx-secondary')}>
        <Icon name={m.icon} size={14} />{m.label}<Icon name="chevron-down" size={12} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={ref} placement="top-start" className="w-[300px]" role="presentation">
        <MenuList onDone={() => setOpen(false)} items={(Object.keys(MODE_LABEL) as Mode[]).map((k) => ({ id: k, label: MODE_LABEL[k].label, hint: MODE_LABEL[k].hint, icon: MODE_LABEL[k].icon, checked: k === value, danger: k === 'bypass',
          onSelect: () => { if (k === 'bypass') void useApp.getState().ask({ title: 'Turn off every check?', body: 'In bypass mode the agent runs commands and edits files without asking. Use it only in a throwaway folder.', confirmLabel: 'Bypass', danger: true }).then((y) => y && onChange(k)); else onChange(k); } }))} />
      </Popover>
    </>
  );
}

function PluginChip({ chip }: { chip: ReturnType<typeof useData.getState>['registry']['composerChips'][number] }) {
  const chips = useApp((s) => s.prefs.chips);
  const value = chips[chip.setting];
  const set = (v: unknown) => useApp.getState().setPrefs({ chips: { ...useApp.getState().prefs.chips, [chip.setting]: v } });
  if (chip.kind === 'toggle') {
    return <button type="button" data-chip={chip.qid} aria-pressed={value === true} onClick={() => set(value !== true)} className={cx('inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px]', value === true ? 'bg-hx-accent-soft text-hx-accent-text' : 'text-hx-muted hover:bg-hx-hover')}>{chip.icon && <Icon name={chip.icon} size={14} />}{chip.title}</button>;
  }
  return (
    <label className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[12.5px] text-hx-secondary hover:bg-hx-hover" data-chip={chip.qid}>
      {chip.icon && <Icon name={chip.icon} size={14} />}{chip.title}:
      <select value={String(value ?? chip.options?.[0] ?? '')} onChange={(e) => set(e.target.value)} className="rounded bg-transparent">{(chip.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
    </label>
  );
}

/** Values of plugins' composer chips, sent as context with a message. */
export function chipContext(): string {
  const { registry } = useData.getState();
  const chips = useApp.getState().prefs.chips;
  const parts = registry.composerChips.filter((c) => chips[c.setting] !== undefined && chips[c.setting] !== false).map((c) => `${c.setting}=${String(chips[c.setting])}`);
  return parts.length ? `\n\n<composer_context>${parts.join('; ')}</composer_context>` : '';
}
