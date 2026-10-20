import { PublishError } from '../git/publish.ts';
import type { Tool } from './types.ts';
import { bool, str } from './types.ts';

// publish_branch: the end of a coding task - the work as a branch and a pull
// request. The harness pushes (with a token the agent never sees), only to the
// repository the session came from, never with force.

export const publishTool: Tool = {
  kind: 'external', parallelSafe: false, remoteable: false,
  spec: {
    name: 'publish_branch',
    description: 'Publish the work as a git branch and open a pull request for it. Commit first (or pass commit_message to commit every change). Pushes only to the repository this session came from; never to the base branch and never with force. Use it when the user asks for a branch or pull request, after the tests pass.',
    input_schema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'New branch name, e.g. fix/login-timeout' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request description: what changed, why, how it was verified' },
        commit_message: { type: 'string', description: 'Commit all changes with this message first' },
        draft: { type: 'boolean' },
        base: { type: 'string', description: 'Base branch (default: the repository\'s default branch)' },
      },
      required: ['branch', 'title'],
    },
  },
  summarize: (i) => `publish ${str(i.branch)}: ${str(i.title)}`,
  async run(input, ctx) {
    const pub = ctx.services?.publish;
    if (!pub) return { content: 'Publishing is not available for this session (it was not created from a repository, or this server has publishing turned off).', is_error: true };
    try {
      const r = await pub({ branch: str(input.branch), title: str(input.title), body: str(input.body) || undefined, commitMessage: str(input.commit_message) || undefined, draft: bool(input.draft), base: str(input.base) || undefined }, ctx.signal);
      const pr = r.pullRequest ? `\nPull request #${r.pullRequest.number}: ${r.pullRequest.url}` : '';
      return { content: `Pushed ${r.branch} (${r.commit.slice(0, 10)}) to ${r.pushedTo}.${pr}${r.note ? `\n${r.note}` : ''}` };
    } catch (e) {
      if (e instanceof PublishError) return { content: e.message, is_error: true };
      throw e;
    }
  },
};
