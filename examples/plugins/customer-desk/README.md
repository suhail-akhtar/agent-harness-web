# Customer desk (example)

A complete app as a harness plugin: a support desk the agent and the team work in together. It uses
the whole plugin SDK, and the deep review gives it 100 with no findings.

| | |
|---|---|
| `harness-plugin.json` | the menu (Overview, Tickets, Contacts), five pages, a panel, commands (one agents may run), `/ticket`, settings, a sidebar badge, a Dashboards data source, a home prompt |
| `index.ts` | six tools (one has a sub-agent draft replies), versioned data (`api.store`, version 2 with a migration from 1), ten routes, a token webhook that opens a ticket and starts a triage conversation with the text fenced as untrusted, a background sweep behind a lease |
| `lib/desk.ts` | the data and its rules, apart from the harness |
| `agents/` | `desk-writer` (replies), `desk-triager` (triage) |
| `workflows/desk-triage.json` | triage, a person approves the drafts, then they are added |
| `skills/customer-desk/` | when and how the agent uses the tools |
| `GUIDE.md` | what agents read about it in desktop sessions |
| `ui/` | the pages, on the UI kit; `common.js` is shared |
| `test/desk.test.ts` | the test kit: tools, the migration, routes, the webhook, a scripted conversation |

```bash
npm run plugin -- test examples/plugins/customer-desk
npm run plugin -- check examples/plugins/customer-desk --deep
```

In the desktop app: **Plugins > Developer > Load a plugin folder…** and pick this folder. It shows
under **Custom > Customer desk**; **Open as app** gives it a window of its own.

The SDK guide: [docs/plugin-sdk/README.md](../../../docs/plugin-sdk/README.md).
