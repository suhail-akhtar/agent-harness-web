/**
 * core.gallery: every standard component of @harness/ui on one page, in its states (Command palette >
 * "Open the component gallery"). The reference a page or plugin is built from, and the place to see a
 * change to a component everywhere at once, in both themes.
 */

import React, { useState } from 'react';
import { ActionPanel, Badge, Button, Callout, Card, Checkbox, CheckboxGroup, ChoiceGroup, ConfirmDialog, EmptyState, Field, IconButton, IconTile, InfoNote, Input, Kbd, ListRow, Meta, Modal, OptionCards, Page, PageHeader, PageState, Section, Select, Spinner, StatCard, StatGrid, StatusDot, Switch, Tabs, Textarea, Tooltip, toast } from '@harness/ui';
import type { BuiltinPlugin } from '../state/data';

function Gallery(): React.ReactElement {
  const [tab, setTab] = useState('one');
  const [on, setOn] = useState(true);
  const [ticked, setTicked] = useState(false);
  const [pick, setPick] = useState('b');
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [chip, setChip] = useState('daily');
  const [seg, setSeg] = useState('all');
  const [card, setCard] = useState('plan');
  const [checks, setChecks] = useState<string[]>(['read']);
  return (
    <Page data-gallery width="wide" title="Components" subtitle="The standard parts every page and plugin is built from (@harness/ui)." actions={<Button icon="refresh" onClick={() => toast('A toast', { kind: 'success' })}>Show a toast</Button>}>
      <Section title="Type scale" description="Nine roles, each a share of the Text size setting (Settings > Appearance). Pages never use a pixel size.">
        <Card className="space-y-1">
          <div className="text-display font-semibold">Display: a home greeting</div>
          <div className="text-heading font-semibold">Heading: a page title</div>
          <div className="text-title font-semibold">Title: a dialog or a card title</div>
          <div className="text-body-lg">Body large: a list item's name</div>
          <div className="text-body">Body: most text in the app</div>
          <div className="text-small text-hx-secondary">Small: help under a field, a card's description</div>
          <div className="text-caption text-hx-muted">Caption: facts, times, counts</div>
          <div className="text-tiny font-semibold uppercase tracking-wide text-hx-muted">Tiny: a section label</div>
          <div className="text-micro text-hx-muted">Micro: a key cap, a tiny count</div>
        </Card>
      </Section>
      <Section title="Page header" description="Every page's title row (Page draws it); a module's home adds its icon.">
        <Card><PageHeader icon="bot" title="A module" subtitle="What it is for, in one line." actions={<><Button size="sm" variant="ghost">Secondary</Button><Button size="sm" variant="primary" icon="plus">New</Button></>} /></Card>
      </Section>
      <Section title="Cards, stats and facts" description="One card (12px corners, a subtle border); selected, toned and dimmed states.">
        <StatGrid>
          <StatCard label="conversations working" value={3} tone="accent" onClick={() => toast('Working now')} />
          <StatCard label="waiting for you" value={2} tone="warning" />
          <StatCard label="done today" value={14} tone="success" />
          <StatCard label="spent today" value="$0.42" />
        </StatGrid>
        <div className="grid gap-3 md:grid-cols-3">
          <Card interactive><div className="flex items-start gap-2.5"><IconTile icon="bot" /><div className="min-w-0"><div className="text-body font-semibold">A card</div><Meta items={['claude-sonnet-5-5', '3 tools', 'read only']} /></div></div></Card>
          <Card selected><div className="text-body font-semibold">Selected</div><div className="text-small text-hx-muted">The chosen one.</div></Card>
          <Card tone="danger"><div className="flex items-center gap-2 text-body font-semibold"><StatusDot status="failed" />Failed</div><div className="text-small text-hx-muted">A status card.</div></Card>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-4 text-small text-hx-secondary">
          {['running', 'waiting', 'done', 'failed', 'idle'].map((st) => <span key={st} className="inline-flex items-center gap-1.5"><StatusDot status={st} />{st}</span>)}
          {(['accent', 'success', 'warning', 'danger', 'info', 'neutral'] as const).map((t) => <IconTile key={t} icon="sparkles" size="sm" tone={t} />)}
        </div>
      </Section>
      <Section title="Callouts" description="A note in a form or a list, or a banner across a page with its action.">
        <div className="space-y-2">
          <Callout tone="info">An information note.</Callout>
          <Callout tone="success" title="Saved">Version 3 is current.</Callout>
          <Callout tone="danger">Something went wrong, and what to do about it.</Callout>
          <Callout variant="banner" tone="warning" actions={<Button size="sm">Make it quieter</Button>}>3 of its last 4 updates were dismissed.</Callout>
          <Callout variant="banner" tone="accent" icon="eye" actions={<Button size="sm" variant="primary">Review</Button>} onDismiss={() => toast('Dismissed')}>Noticing practised quietly for a week.</Callout>
        </div>
      </Section>
      <Section title="Choices" description="One of a few: chips (many options), a segmented track (two to four), cards (each explained). Arrow keys move them.">
        <div className="space-y-3">
          <ChoiceGroup name="gallery-chips" label="How often" value={chip} onChange={setChip} options={[{ id: 'once', label: 'Once' }, { id: 'hourly', label: 'Hourly' }, { id: 'daily', label: 'Daily' }, { id: 'weekdays', label: 'Weekdays' }, { id: 'weekly', label: 'Weekly' }]} />
          <ChoiceGroup variant="segmented" name="gallery-seg" label="Tools" value={seg} onChange={setSeg} options={[{ id: 'all', label: 'All tools' }, { id: 'some', label: 'Only these' }]} />
          <OptionCards name="gallery-cards" label="Autonomy" value={card} onChange={setCard} options={[{ id: 'plan', title: 'Read only', detail: 'It reads and plans; changes wait for you.' }, { id: 'default', title: 'Ask me', detail: 'It asks before edits and commands.' }, { id: 'auto', title: 'A checker decides', detail: 'Safe steps go ahead; the rest wait.' }, { id: 'dontAsk', title: 'Never ask', detail: 'What needs approval is refused.' }]} />
          <CheckboxGroup mono name="gallery-checks" items={[{ id: 'read', label: 'read', hint: 'Read a file' }, { id: 'grep', label: 'grep', hint: 'Search file contents' }, { id: 'bash', label: 'bash', hint: 'Run a command' }, { id: 'write', label: 'write', hint: 'Write a file' }]} value={checks} onChange={setChecks} />
        </div>
      </Section>
      <Section title="Buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Primary</Button><Button>Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="subtle">Subtle</Button><Button variant="danger">Danger</Button>
          <Button loading>Loading</Button><Button disabled>Disabled</Button><Button size="sm" icon="plus">Small</Button>
          <Tooltip label="An icon button has a label"><IconButton icon="settings" label="Settings" /></Tooltip><Kbd keys="Ctrl+K" />
        </div>
      </Section>
      <Section title="Badges and notes">
        <div className="mb-3 flex flex-wrap gap-2"><Badge>Neutral</Badge><Badge tone="accent">Accent</Badge><Badge tone="success">Success</Badge><Badge tone="warning">Warning</Badge><Badge tone="danger">Danger</Badge><Badge tone="info">Info</Badge></div>
        <div className="space-y-2"><InfoNote>An information note.</InfoNote><InfoNote tone="warning">A warning note.</InfoNote><InfoNote tone="danger">Something went wrong, and what to do about it.</InfoNote></div>
      </Section>
      <Section title="Form controls">
        <Card className="px-4">
          <Field label="Text" help="Help under the control."><Input placeholder="Type here" icon="search" /></Field>
          <Field label="With an error" error="This needs a value."><Input /></Field>
          <Field label="Long text"><Textarea rows={2} placeholder="Several lines" /></Field>
          <Field label="Choice" inline><Select value={pick} onChange={setPick} options={[{ value: 'a', label: 'First' }, { value: 'b', label: 'Second' }]} className="w-40" /></Field>
          <Field label="Switch" inline><Switch checked={on} onChange={setOn} label="Switch" /></Field>
          <Field label="Checkbox" inline><Checkbox checked={ticked} onChange={setTicked} label="Tick me" /></Field>
        </Card>
      </Section>
      <Section title="Tabs">
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'one', label: 'One', count: 3 }, { id: 'two', label: 'Two', icon: 'chart' }, { id: 'three', label: 'Three' }]} />
      </Section>
      <Section title="List rows">
        <div className="mb-3 space-y-0.5"><ListRow icon="chat" title="A plain row" subtitle="A line under it" meta="Today" /><ListRow icon="folder" title="The current one" active meta={<Badge tone="accent">3</Badge>} /></div>
        <div className="grid gap-2 sm:grid-cols-2"><ListRow card icon="file" title="A card row" subtitle="For lists of things on a page" /><ListRow card icon="sparkles" title="Another card row" subtitle="Clickable, with a focus ring" /></div>
      </Section>
      <Section title="States">
        <div className="grid gap-3 md:grid-cols-3">
          <Card><PageState kind="loading" title="Loading the list" /></Card>
          <Card><PageState kind="error" detail="The engine answered 503." onRetry={() => toast('Retried')} /></Card>
          <Card><PageState kind="empty" icon="inbox" title="Nothing here yet" detail="What will show here, and how to get some." /></Card>
        </div>
        <div className="mt-3 flex items-center gap-2 text-small text-hx-muted"><Spinner /> Inline loading</div>
      </Section>
      <Section title="Decision panel">
        <ActionPanel label="Approval" icon="shield" title="Ship the release?" maxHeight="220px" footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost">Send back</Button><Button size="sm" variant="primary">Approve</Button></div>}>
          <p className="text-body text-hx-secondary">The details scroll; the decision stays in view.</p>
          {Array.from({ length: 8 }, (_, i) => <p key={i} className="text-small text-hx-muted">Detail line {i + 1}</p>)}
        </ActionPanel>
      </Section>
      <Section title="Dialogs">
        <div className="flex gap-2"><Button onClick={() => setModal(true)}>Open a dialog</Button><Button onClick={() => setConfirm(true)}>Ask to confirm</Button></div>
        <Modal open={modal} onClose={() => setModal(false)} title="A dialog" footer={<Button variant="primary" onClick={() => setModal(false)}>Done</Button>}><p className="text-body">Escape or the scrim closes it; focus stays inside.</p></Modal>
        <ConfirmDialog open={confirm} title="Remove this?" body="A confirmation says what happens." confirmLabel="Remove" danger onAnswer={() => setConfirm(false)} />
      </Section>
      <Section title="Empty states" description="A whole page, a section (a dashed box), or one line.">
        <Card><EmptyState icon="sparkles" title="Empty state" action={<Button variant="primary">Do the first thing</Button>}>What goes here and how to start.</EmptyState></Card>
        <div className="mt-3"><EmptyState variant="section" icon="bot" title="No agents of your own yet" action={<Button size="sm" variant="primary">Make one</Button>}>Describe one and it is drafted for you to check.</EmptyState></div>
        <div className="mt-3"><EmptyState variant="inline" title="Nothing scheduled." /></div>
      </Section>
    </Page>
  );
}

export const coreGallery: BuiltinPlugin = {
  name: 'core.gallery', version: '0.1.0', description: 'The standard components on one page.',
  ui: {
    apiVersion: 1, displayName: 'Components', icon: 'apps', trust: 'native', capabilities: [],
    contributes: {
      views: [{ id: 'gallery', title: 'Components', kind: 'native', component: 'Gallery' }],
      commands: [{ id: 'open', title: 'Open the component gallery', category: 'Developer', icon: 'apps', action: { type: 'open-view', view: 'gallery' } }],
    },
  },
  components: { Gallery },
};
