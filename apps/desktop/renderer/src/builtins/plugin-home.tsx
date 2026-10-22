/**
 * The home the shell draws for a plugin that declares none (core.shell:plugin-home?plugin=<name>),
 * from its manifest alone: what it is, its pages as cards, its commands and slash commands as
 * actions, its settings, its status items and home cards, and "Ask the agent about <plugin>" (a
 * prompt typed in, never sent). The same building blocks frame a declared native home.
 */

import React from 'react';
import { Badge, Button, EmptyState, Icon, Markdown, cx } from '@harness/ui';
import { navigate, prefill, showFullWindow, useApp } from '../state/app';
import { useData } from '../state/data';
import { HomeCardHost } from '../registry/PluginView';
import { runCommand } from '../registry/actions';
import { interpolate } from '../registry/registry';
import { guideFor, homeModel, type HomeModel } from '../registry/modules';
import { formatChord } from '../registry/keybindings';
import { platform } from '../bridge';

/** The page around a plugin's home: its title, what it is, "Ask the agent" and "Guide for agents". */
export function ModuleHeader({ model, children }: { model: Pick<HomeModel, 'plugin' | 'title' | 'icon' | 'description' | 'purpose' | 'ask'>; children?: React.ReactNode }): React.ReactElement {
  const registry = useData((s) => s.registry);
  return (
    <header className="mb-6 flex flex-wrap items-start gap-4" data-module-header={model.plugin}>
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-hx-accent/12 text-hx-accent-text"><Icon name={model.icon} size={22} /></span>
      <div className="min-w-0 flex-1">
        <h1 className="text-[22px] font-semibold tracking-tight">{model.title}</h1>
        <p className="mt-0.5 max-w-3xl text-[13.5px] text-hx-secondary">{model.purpose}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {children}
        <Button size="sm" variant="ghost" icon="book" data-module-guide={model.plugin} onClick={() => showFullWindow(`${model.title}: guide for agents`, <div className="hx-scroll h-full overflow-auto"><div className="mx-auto max-w-column px-6 py-6"><Markdown text={guideFor(registry, model.plugin) ?? ''} /></div></div>)}>Guide for agents</Button>
        <Button size="sm" variant="primary" icon="sparkles" data-home-ask={model.plugin} onClick={() => prefill(model.ask, true)}>Ask the agent about {model.title}</Button>
      </div>
    </header>
  );
}

/** A section of a home page with a heading. */
export function HomeSection({ title, children, action, id }: { title: string; children: React.ReactNode; action?: React.ReactNode; id?: string }): React.ReactElement {
  return (
    <section className="mb-7" {...(id ? { 'data-home-section': id } : {})}>
      <div className="mb-2.5 flex items-center gap-2"><h2 className="flex-1 text-[12px] font-semibold uppercase tracking-wide text-hx-muted">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

export function PluginHome({ params }: { params: Record<string, string> }): React.ReactElement {
  const registry = useData((s) => s.registry);
  const badges = useApp((s) => s.badges);
  const plugin = params.plugin ?? '';
  const m = homeModel(registry, plugin);
  if (!m) return <EmptyState icon="puzzle" title="This plugin is not on" action={<Button onClick={() => navigate({ view: 'core.plugins:plugins' })}>Plugins</Button>}>{plugin || 'No plugin'} is switched off or not installed.</EmptyState>;
  const commands = m.actions.filter((a) => a.kind === 'command');
  const slash = m.actions.filter((a) => a.kind === 'slash');
  return (
    <div className="hx-scroll h-full overflow-y-auto" data-plugin-home={plugin}>
      <div className="mx-auto max-w-5xl px-6 py-8">
        <ModuleHeader model={m} />
        {m.description && m.description !== m.purpose && <p className="-mt-3 mb-6 max-w-3xl text-[13px] leading-relaxed text-hx-muted">{m.description}</p>}
        {m.statusItems.length > 0 && (
          <div className="mb-6 flex flex-wrap gap-2">
            {m.statusItems.map((s) => (
              <button key={s.id} type="button" data-home-status={s.id} disabled={!s.command} onClick={() => s.command && void runCommand(s.command)} className="inline-flex items-center gap-2 rounded-full border border-hx-border-subtle bg-hx-elevated px-3 py-1.5 text-[12.5px] text-hx-secondary hover:border-hx-border disabled:hover:border-hx-border-subtle">
                <Icon name="activity" size={13} />{interpolate(s.text, badges)}
              </button>
            ))}
          </div>
        )}
        {m.pages.length > 0 && (
          <HomeSection title="Pages" id="pages">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {m.pages.map((p) => {
                const b = p.badge ? badges[p.badge] : undefined;
                return (
                  <button key={p.id} type="button" data-home-page={p.id} onClick={() => navigate(p.route)} className="group flex min-h-[92px] flex-col items-start gap-1.5 rounded-xl border border-hx-border-subtle bg-hx-elevated p-4 text-left transition-colors hover:border-hx-border">
                    <span className="flex w-full items-center gap-2"><Icon name={p.icon ?? 'arrow-right'} size={16} className="text-hx-accent-text" /><span className="flex-1 text-[14px] font-medium">{p.title}</span>{b !== undefined && b !== null && b !== 0 && <Badge tone="accent">{String(b)}</Badge>}<Icon name="arrow-right" size={14} className="text-hx-muted opacity-0 transition-opacity group-hover:opacity-100" /></span>
                    {p.description && <span className="line-clamp-2 text-[12.5px] text-hx-muted">{p.description}</span>}
                  </button>
                );
              })}
            </div>
          </HomeSection>
        )}
        {(commands.length > 0 || slash.length > 0 || m.prompts.length > 0) && (
          <HomeSection title="Actions" id="actions">
            <div className="grid gap-2 sm:grid-cols-2">
              {commands.map((a) => (
                <button key={a.id} type="button" data-home-action={a.id} onClick={() => void runCommand(a.run)} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left text-[13px] hover:bg-hx-hover">
                  <Icon name={a.icon} size={15} className="text-hx-secondary" /><span className="min-w-0 flex-1 truncate">{a.title}</span>
                  {a.agent && <span className="rounded bg-hx-pill px-1.5 py-0.5 text-[10.5px] text-hx-muted" title="Agents may run it (desktop_command)">agents</span>}
                  {a.hint && <span className="text-[11px] text-hx-muted">{formatChord(a.hint, platform)}</span>}
                </button>
              ))}
              {slash.map((a) => (
                <button key={a.id} type="button" data-home-action={a.id} onClick={() => prefill(a.run, true)} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left text-[13px] hover:bg-hx-hover">
                  <span className="font-mono text-[12.5px] text-hx-accent-text">{a.title}</span><span className="min-w-0 flex-1 truncate text-hx-muted">{a.hint}</span>
                </button>
              ))}
              {m.prompts.map((p) => (
                <button key={p.id} type="button" data-home-action={p.id} onClick={() => prefill(p.prompt, true)} className="flex items-center gap-3 rounded-lg border border-hx-border-subtle px-3 py-2.5 text-left text-[13px] hover:bg-hx-hover">
                  <Icon name={p.icon ?? 'sparkles'} size={15} className="text-hx-accent-text" /><span className="min-w-0 flex-1 truncate">{p.title}</span>
                </button>
              ))}
            </div>
          </HomeSection>
        )}
        {m.homeCards.length > 0 && (
          <HomeSection title="At a glance" id="cards">
            <div className="grid gap-3 md:grid-cols-2">{registry.homeCards.filter((c) => m.homeCards.includes(c.qid)).map((c) => <HomeCardHost key={c.qid} card={c} />)}</div>
          </HomeSection>
        )}
        {m.settings.length > 0 && (
          <HomeSection title="Settings" id="settings">
            <div className="flex flex-wrap gap-2">
              {m.settings.map((s) => <Button key={s.id} size="sm" icon="settings" data-home-settings={s.id} onClick={() => useApp.getState().openSettings(s.id)}>{s.title}</Button>)}
            </div>
          </HomeSection>
        )}
        {!m.pages.length && !m.actions.length && !m.settings.length && <p className={cx('text-[13px] text-hx-muted')}>This plugin adds no pages or commands of its own: it works in conversations (renderers, tools).</p>}
      </div>
    </div>
  );
}
