# __NAME__

An agent built on the harness kit.

```bash
npm install
npm test                       # a scripted model: no key, no cost
cp .env.example .env           # add a model key
npm start -- "Where is order A1?"
```

- `agent.ts`: your agent. Change the tool, the model and the mode here.
- `app.ts`: runs it once from the command line. Put your own front end here.
- `test/`: tests with a scripted model, from `@harness/plugin-sdk/testing`.

To give it pages in the desktop app, or to share tools between apps, make a plugin: `npx harness plugin new my-plugin`.
The kit's `docs/plugin-sdk` has the guide.
