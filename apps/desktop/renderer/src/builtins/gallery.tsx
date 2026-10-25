/**
 * core.gallery: every standard component of @harness/ui on one page, in its states (Command palette >
 * "Open the component gallery"). The reference a page or plugin is built from, and the place to see a
 * change to a component everywhere at once, in both themes.
 */

import React, { useState } from 'react';
import { ActionPanel, Badge, Button, Card, Checkbox, ConfirmDialog, EmptyState, Field, IconButton, InfoNote, Input, Kbd, ListRow, Modal, Page, PageState, Section, Select, Spinner, Switch, Tabs, Textarea, Tooltip, toast } from '@harness/ui';
import type { BuiltinPlugin } from '../state/data';

function Gallery(): React.ReactElement {
  const [tab, setTab] = useState('one');
  const [on, setOn] = useState(true);
  const [ticked, setTicked] = useState(false);
  const [pick, setPick] = useState('b');
  const [modal, setModal] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <Page data-gallery width="wide" title="Components" subtitle="The standard parts every page and plugin is built from (@harness/ui)." actions={<Button icon="refresh" onClick={() => toast('A toast', { kind: 'success' })}>Show a toast</Button>}>
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
        <div className="mt-3 flex items-center gap-2 text-[12.5px] text-hx-muted"><Spinner /> Inline loading</div>
      </Section>
      <Section title="Decision panel">
        <ActionPanel label="Approval" icon="shield" title="Ship the release?" maxHeight="220px" footer={<div className="flex justify-end gap-2"><Button size="sm" variant="ghost">Send back</Button><Button size="sm" variant="primary">Approve</Button></div>}>
          <p className="text-[13px] text-hx-secondary">The details scroll; the decision stays in view.</p>
          {Array.from({ length: 8 }, (_, i) => <p key={i} className="text-[12.5px] text-hx-muted">Detail line {i + 1}</p>)}
        </ActionPanel>
      </Section>
      <Section title="Dialogs">
        <div className="flex gap-2"><Button onClick={() => setModal(true)}>Open a dialog</Button><Button onClick={() => setConfirm(true)}>Ask to confirm</Button></div>
        <Modal open={modal} onClose={() => setModal(false)} title="A dialog" footer={<Button variant="primary" onClick={() => setModal(false)}>Done</Button>}><p className="text-[13px]">Escape or the scrim closes it; focus stays inside.</p></Modal>
        <ConfirmDialog open={confirm} title="Remove this?" body="A confirmation says what happens." confirmLabel="Remove" danger onAnswer={() => setConfirm(false)} />
      </Section>
      <Section title="Empty state">
        <Card><EmptyState icon="sparkles" title="Empty state" action={<Button variant="primary">Do the first thing</Button>}>What goes here and how to start.</EmptyState></Card>
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
