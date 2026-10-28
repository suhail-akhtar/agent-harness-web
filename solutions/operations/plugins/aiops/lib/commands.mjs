// The remote shell commands the tools build from inventory names. Every name is
// checked again here, right before it goes into a command (whatever the
// inventory's validation said), and every value is shell-quoted: a container,
// unit or file name can never be more than one argument, nor an option.

import { shQuote } from './hoststats.mjs';
import { assertSafe } from './inventory.mjs';

/** `docker logs` of a container on a host, since a duration ("15m"). */
export const dockerLogsCmd = (container, since, tail) => `docker logs --timestamps --since ${shQuote(since)} --tail ${Number(tail) | 0} -- ${shQuote(assertSafe('container', container))} 2>&1`;

/** The last lines of a file on a host. */
export const tailFileCmd = (file, lines) => `tail -n ${Number(lines) | 0} -- ${shQuote(assertSafe('file', file))}`;

/** A container's state on a host (status, health, restarts, started). */
export const CONTAINER_STATE_FORMAT = '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}} {{.State.StartedAt}}';
export const containerStateCmd = (container) => `docker inspect -f ${shQuote(CONTAINER_STATE_FORMAT)} -- ${shQuote(assertSafe('container', container))}`;

/** A systemd unit's state on a host. */
export const unitStateCmd = (unit) => { const u = shQuote(assertSafe('unit', unit)); return `systemctl is-active -- ${u}; systemctl show -p ActiveEnterTimestamp,NRestarts -- ${u}`; };

const ACTIONS = ['restart', 'start', 'stop'];
/** restart / start / stop a service's container or unit on a host (sudo -n unless the user is root). */
export function controlCmd(action, { container, unit }, user) {
  if (!ACTIONS.includes(action)) throw new Error(`"${action}" is not restart, start or stop: refused`);
  if (container !== undefined) return `docker ${action} -- ${shQuote(assertSafe('container', container))}`;
  return `${user === 'root' ? '' : 'sudo -n '}systemctl ${action} -- ${shQuote(assertSafe('unit', unit))}`;
}
