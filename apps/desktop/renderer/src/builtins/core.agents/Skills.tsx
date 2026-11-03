/**
 * The person's own skills: what each holds (scripts, tests, references, assets) and uses (tools, MCP servers), import
 * of skill packages (an Anthropic .skill, a .zip, or a SKILL.md), a skill made by an agent (the skill-creator), and
 * each one's SKILL.md and files. Skills are given to agents in the agent builder (their skills).
 */
import React, { useEffect, useState } from 'react';
import type { SkillInfo } from '@harness/client';
import { Badge, Button, Callout, Card, EmptyState, Modal, Page, toast } from '@harness/ui';
import { client } from '../../state/data';
import { prefill } from '../../state/app';

const toBase64 = async (f: File) => {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export function YourSkills(): React.ReactElement {
  const [list, setList] = useState<SkillInfo[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<{ name: string; skill: string; files: string[] } | null>(null);
  const reload = () => client.skills.list().then((l) => { setList(l); setError(''); }).catch((e: Error) => setError(e.message));
  useEffect(() => { void reload(); }, []);
  const importFile = () => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.skill,.zip,.md'; input.multiple = true;
    input.onchange = async () => {
      for (const f of Array.from(input.files ?? [])) {
        try {
          const r = /\.md$/i.test(f.name) ? await client.skills.import({ text: await f.text() }) : await client.skills.import({ data: await toBase64(f) });
          for (const s of r.skills) toast(s.ok ? `Imported ${s.name}${s.serversAdded?.length ? ` (its MCP servers ${s.serversAdded.join(', ')} were added, switched off)` : ''}` : `${s.name}: ${s.problems.join('; ')}`, { kind: s.ok ? 'success' : 'error' });
        } catch (e) { toast(`${f.name}: ${(e as Error).message}`, { kind: 'error' }); }
      }
      void reload();
    };
    input.click();
  };
  const remove = async (name: string) => { try { await client.skills.remove(name); toast(`Removed ${name}`); void reload(); } catch (e) { toast((e as Error).message, { kind: 'error' }); } };
  const view = async (name: string) => { try { const r = await client.skills.get(name); setOpen({ name, skill: r.skill, files: r.files }); } catch (e) { toast((e as Error).message, { kind: 'error' }); } };
  const make = () => prefill('Use the skill-creator skill to make a skill for: ', true);
  return (
    <Page title="Your skills">
      <div data-your-skills>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <p className="min-w-0 flex-1 text-body text-hx-secondary">Know-how an agent loads when the work needs it: instructions, and for exact work, scripts it runs, with their tests. Give a skill to an agent in the agent builder; every conversation of yours can use them.</p>
          <Button icon="upload" variant="ghost" onClick={importFile} data-skills-import>Import</Button>
          <Button icon="sparkles" variant="primary" onClick={make} data-skills-make>Make a skill</Button>
        </div>
        {error && <Callout tone="danger" className="mb-4">{error}</Callout>}
        {list === null ? <p className="text-body text-hx-muted">Loading…</p> : !list.length
          ? <EmptyState icon="book" title="No skills of your own yet" action={<Button variant="primary" icon="sparkles" onClick={make}>Make one</Button>}>Describe the work and an agent builds the skill (with scripts and tests where the work must be exact), or import a .skill or .zip package, or a SKILL.md.</EmptyState>
          : (
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-skills-list>
              {list.map((s) => (
                <Card key={s.name} className="flex flex-col gap-2 p-4" data-skill={s.name}>
                  <div className="flex items-center justify-between gap-2"><span className="font-semibold">{s.name}</span>{s.version && <span className="text-tiny text-hx-muted">v{s.version}</span>}</div>
                  <p className="text-small text-hx-secondary">{s.description}</p>
                  <div className="flex flex-wrap gap-1">
                    {s.scripts.length > 0 && <Badge tone="accent">{s.scripts.length} script{s.scripts.length > 1 ? 's' : ''}</Badge>}
                    {s.tests.length > 0 && <Badge tone="success">{s.tests.length} test{s.tests.length > 1 ? 's' : ''}</Badge>}
                    {s.references.length > 0 && <Badge>{s.references.length} reference{s.references.length > 1 ? 's' : ''}</Badge>}
                    {s.mcpServers.length > 0 && <Badge tone="warning">MCP: {s.mcpServers.join(', ')}</Badge>}
                    {s.tools.length > 0 && <Badge>tools: {s.tools.slice(0, 4).join(', ')}{s.tools.length > 4 ? '…' : ''}</Badge>}
                  </div>
                  <div className="mt-auto flex gap-2 pt-2">
                    <Button size="sm" variant="ghost" icon="eye" onClick={() => void view(s.name)}>View</Button>
                    <Button size="sm" variant="ghost" icon="trash" onClick={() => void remove(s.name)}>Remove</Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        {open && (
          <Modal open title={open.name} onClose={() => setOpen(null)}>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap text-small" data-skill-md>{open.skill}</pre>
            {open.files.length > 0 && <p className="mt-3 text-tiny text-hx-muted">Files: {open.files.join(', ')}</p>}
          </Modal>
        )}
      </div>
    </Page>
  );
}
