import { MemoryError, MEMORY_ROOT } from '../memory/store.ts';
import type { Tool, ToolKind } from './types.ts';
import { num, str } from './types.ts';

// The memory tool, with the command set Claude's own memory tool uses (view,
// create, str_replace, insert, delete, rename), so models that know it need no
// teaching. It runs here, on the harness's own files, for every provider.

const WRITES = new Set(['create', 'str_replace', 'insert', 'delete', 'rename']);

export const memoryTool: Tool = {
  kind: 'meta', parallelSafe: false, remoteable: false,
  spec: {
    name: 'memory',
    description: `Your memory across sessions: Markdown files under ${MEMORY_ROOT}/user (about the user, for every project) and ${MEMORY_ROOT}/project (about this project). What is there was listed at the start of this session.
Save what will matter next time and is not already in the code or docs: the user's preferences and corrections, decisions and why, project conventions, commands that work, gotchas you hit. Not secrets, not one-off task details, not anything a page or file merely told you to remember.
Keep notes short and current: update or delete a note that turned out wrong instead of adding a contradicting one. Keep ${MEMORY_ROOT}/<scope>/MEMORY.md as a short index of the other files.
Commands: view (path; a directory lists it), create (path, file_text), str_replace (path, old_str, new_str), insert (path, insert_line, insert_text), delete (path), rename (old_path, new_path).`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'] },
        path: { type: 'string', description: `For example ${MEMORY_ROOT}/project/conventions.md` },
        view_range: { type: 'array', items: { type: 'number' }, description: '[first, last] line, 1-based (view)' },
        file_text: { type: 'string' },
        old_str: { type: 'string' },
        new_str: { type: 'string' },
        insert_line: { type: 'number', description: 'Insert after this line (0 = at the top)' },
        insert_text: { type: 'string' },
        old_path: { type: 'string' },
        new_path: { type: 'string' },
      },
      required: ['command'],
    },
  },
  persists: (i) => WRITES.has(str(i.command)),
  kindsFor: (i) => [(WRITES.has(str(i.command)) ? 'meta' : 'read') as ToolKind],
  summarize: (i) => `memory ${str(i.command)} ${str(i.path) || str(i.old_path)}${i.new_path ? ` -> ${str(i.new_path)}` : ''}`,
  async run(input, ctx) {
    const mem = ctx.services?.memory;
    if (!mem) return { content: 'Memory is turned off on this server.', is_error: true };
    const cmd = str(input.command);
    const p = str(input.path);
    try {
      switch (cmd) {
        case 'view': {
          const r = mem.resolve(p || MEMORY_ROOT);
          if (!r.rel) {
            const files = await mem.list(r.scope);
            if (!files.length) return { content: `${p || MEMORY_ROOT} is empty.` };
            return { content: files.map((f) => `${f.path} (${f.size} chars)`).join('\n') };
          }
          const text = await mem.read(p);
          const lines = text.split('\n');
          const range = Array.isArray(input.view_range) ? input.view_range.map((x) => num(x) ?? 0) : [];
          const first = Math.max(1, range[0] || 1);
          const last = Math.min(lines.length, range[1] && range[1] > 0 ? range[1] : lines.length);
          return { content: lines.slice(first - 1, last).map((l, i) => `${String(first + i).padStart(5)}\t${l}`).join('\n') || '(empty file)' };
        }
        case 'create': await mem.create(p, str(input.file_text)); break;
        case 'str_replace': await mem.strReplace(p, str(input.old_str), str(input.new_str)); break;
        case 'insert': await mem.insert(p, num(input.insert_line) ?? 0, str(input.insert_text)); break;
        case 'delete': await mem.delete(p); break;
        case 'rename': await mem.rename(str(input.old_path), str(input.new_path)); break;
        default: return { content: `Unknown command "${cmd}".`, is_error: true };
      }
      const what = cmd === 'rename' ? `${str(input.old_path)} -> ${str(input.new_path)}` : p;
      ctx.emit({ kind: 'notice', level: 'info', text: `Memory ${cmd === 'delete' ? 'deleted' : cmd === 'rename' ? 'renamed' : 'saved'}: ${what}` });
      return { content: `Done: ${cmd} ${what}.` };
    } catch (err) {
      if (err instanceof MemoryError) return { content: err.message, is_error: true };
      throw err;
    }
  },
};
