---
description: A support desk - tickets and contacts the agent and the team work together, triage, reply drafts.
---
# Customer desk

- **Tickets**: desk_ticket_create, desk_ticket_search, desk_ticket_get, desk_ticket_update (status open / waiting / closed, priority, a reply).
- **Contacts**: desk_contact_upsert (by email). Tickets link to their customer.
- **Replies**: desk_reply_draft has the desk-writer sub-agent draft one; add it with desk_ticket_update after the person agrees.
- **Triage**: the desk-triager agent, or the desk-triage workflow (with an approval before replies are added).
- **From outside**: POST /api/plugins/customer-desk/inbound (a route token; JSON subject, from, name, text) opens a ticket and starts a triage conversation, the text fenced as untrusted.
- **Pages**: Overview, Tickets, a ticket, Contacts; a "Desk queue" panel; the open count on the sidebar; a "Support tickets" data source for Dashboards.
- **Data**: the plugin's store "desk" (version 2) on the server.
- Use the customer-desk skill for the steps.
