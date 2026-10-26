// The desk's data and the rules on it, apart from the harness (index.ts wires them to tools and routes).
// A module of its own: a live reload loads it fresh with index.ts.

export type Status = 'open' | 'waiting' | 'closed';
export type Priority = 'low' | 'normal' | 'high' | 'urgent';
export const STATUSES: Status[] = ['open', 'waiting', 'closed'];
export const PRIORITIES: Priority[] = ['low', 'normal', 'high', 'urgent'];

export interface Reply { at: string; by: 'agent' | 'person' | 'customer'; text: string }
export interface Ticket {
  id: string;
  title: string;
  body: string;
  status: Status;
  priority: Priority;
  contactId?: string;
  createdAt: string;
  updatedAt: string;
  replies: Reply[];
  /** Where it came from: the agent, the page, or the inbound webhook. */
  source: 'agent' | 'page' | 'inbound';
}
export interface Contact { id: string; name: string; email: string; company: string; notes: string }

/** Version 2 of the desk's data (version 1 had no priorities or replies: see the migration in index.ts). */
export interface Desk { tickets: Ticket[]; contacts: Contact[]; next: number }

export const emptyDesk = (): Desk => ({ tickets: [], contacts: [], next: 1 });

/** Version 1 to 2: every ticket gets a priority and a reply thread. */
export function migrateV1(v1: { tickets?: Array<Partial<Ticket>>; contacts?: Contact[]; next?: number }): Desk {
  return {
    tickets: (v1.tickets ?? []).map((t) => ({
      id: String(t.id), title: String(t.title ?? ''), body: String(t.body ?? ''), status: (STATUSES.includes(t.status as Status) ? t.status : 'open') as Status,
      priority: 'normal', createdAt: t.createdAt ?? new Date(0).toISOString(), updatedAt: t.updatedAt ?? t.createdAt ?? new Date(0).toISOString(), replies: [], source: t.source ?? 'agent',
      ...(t.contactId ? { contactId: t.contactId } : {}),
    })),
    contacts: v1.contacts ?? [],
    next: v1.next ?? (v1.tickets?.length ?? 0) + 1,
  };
}

export function newTicket(d: Desk, t: { title: string; body?: string; priority?: Priority; contactId?: string; source: Ticket['source'] }): Ticket {
  const now = new Date().toISOString();
  const ticket: Ticket = { id: `T-${d.next++}`, title: t.title.trim(), body: (t.body ?? '').trim(), status: 'open', priority: t.priority ?? 'normal', createdAt: now, updatedAt: now, replies: [], source: t.source, ...(t.contactId ? { contactId: t.contactId } : {}) };
  d.tickets.unshift(ticket);
  return ticket;
}

const rank: Record<Priority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Tickets matching words in their title, body, replies or contact; open ones first, then by priority and age. */
export function search(d: Desk, o: { query?: string; status?: Status; limit?: number } = {}): Ticket[] {
  const words = (o.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const contact = (t: Ticket) => d.contacts.find((c) => c.id === t.contactId);
  return d.tickets
    .filter((t) => !o.status || t.status === o.status)
    .filter((t) => { const hay = `${t.id} ${t.title} ${t.body} ${t.replies.map((r) => r.text).join(' ')} ${contact(t)?.name ?? ''} ${contact(t)?.email ?? ''}`.toLowerCase(); return words.every((w) => hay.includes(w)); })
    .sort((a, b) => Number(a.status === 'closed') - Number(b.status === 'closed') || rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt))
    .slice(0, Math.max(1, Math.min(200, o.limit ?? 50)));
}

export function counts(d: Desk): { open: number; waiting: number; closed: number; urgent: number } {
  const n = (s: Status) => d.tickets.filter((t) => t.status === s).length;
  return { open: n('open'), waiting: n('waiting'), closed: n('closed'), urgent: d.tickets.filter((t) => t.status !== 'closed' && t.priority === 'urgent').length };
}

/** A contact by email (updated) or a new one. */
export function upsertContact(d: Desk, c: { name: string; email: string; company?: string; notes?: string }): { contact: Contact; created: boolean } {
  const email = c.email.trim().toLowerCase();
  const had = d.contacts.find((x) => x.email === email);
  if (had) { Object.assign(had, { name: c.name.trim() || had.name, ...(c.company !== undefined ? { company: c.company } : {}), ...(c.notes !== undefined ? { notes: c.notes } : {}) }); return { contact: had, created: false }; }
  const contact: Contact = { id: `C-${d.contacts.length + 1}-${Math.random().toString(36).slice(2, 6)}`, name: c.name.trim(), email, company: c.company ?? '', notes: c.notes ?? '' };
  d.contacts.push(contact);
  return { contact, created: true };
}

/** One line per ticket, for the agent. */
export function line(t: Ticket, d: Desk): string {
  const c = d.contacts.find((x) => x.id === t.contactId);
  return `${t.id} [${t.status}, ${t.priority}] ${t.title}${c ? ` - ${c.name} <${c.email}>` : ''}${t.replies.length ? ` (${t.replies.length} repl${t.replies.length === 1 ? 'y' : 'ies'})` : ''}`;
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
