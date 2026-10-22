// The server half of the hello-frame example: one route its frames call through the host
// (routes.call), served at /api/plugins/hello-frame/greeting. It answers static text, so
// it needs no token: a real route that does anything takes auth: 'token' (see README, Plugins).

export default {
  name: 'hello-frame',
  setup(api) {
    api.registerRoute({
      method: 'GET', path: 'greeting', auth: 'none',
      async handler(req) {
        const who = String(req.query.name ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40) || 'there';
        return { status: 200, body: { text: `Hello, ${who}, from the hello-frame plugin's server half.`, at: new Date().toISOString() } };
      },
    });
  },
};
