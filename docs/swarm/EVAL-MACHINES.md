# A swarm across the person's computers, live (phase 7)

`scripts/live-machines.mjs`, 2026-11-02. Raw results and the machines' own audit logs of the final run:
[EVAL-MACHINES.json](EVAL-MACHINES.json).

## Setup

Two real companions, the built `dist/companion.mjs` as people download it, serve two folders as two computers. Each
has its own policy file, set with the companion's own `policy` command and kept outside the folder:

- **laptop**: swarm agents may read, edit and run commands. This Windows machine has no sandbox, so the owner turned
  `--sandbox-required` off.
- **office**: the default, under which swarm agents may only read.

The conversation runs on Claude Haiku 5.5, in a Docker-sandboxed folder as it would on a server, so it reaches the
computers only through their companions. One task names Grok 4.7. Everything is graded from the computers' folders
and their own audit logs.

## Final run: 11 of 11, $0.027

| # | Asked as a person would | Checked | Result |
|---|---|---|---|
| M1 | On each computer, count the TODO lines in todo.txt and write the number into count.txt there. | The laptop's count.txt holds 7. Nothing was written on the office computer. The office's own audit log shows the write refused by its policy. The answer gives both counts (7 and 12). Nothing landed in the conversation's folder. | 5/5 |
| M2 | On the laptop, run build.sh and tell me when it is done. Stop all is pressed once the script's first line has run there. | The build ran on the laptop. Its audit log shows it stopped, 0.8 s after Stop all. Its processes were killed: built.txt, which the script writes after 45 s, never appeared. | 3/3 |
| M3 | Use Grok 4.7: on the office computer, how many rows of report.csv have the status FAILED? | Grok 4.7 did the work. The count of 7 is right. Nothing was written on the office computer, and its policy refused a command there. | 3/3 |

## What the runs before it found (and what was fixed)

Each run up to the final one failed a check. Every failure was in the harness or in the eval itself:

1. **The conversation went round the companions.** With a plain local shell, the conversation's own agent found the
   "laptop" folder on this disk and ran build.sh there directly. That is a flaw in how the eval simulates two
   machines on one disk, not in the companions. The conversation now works in a Docker sandbox, as on a server.
2. **The stop came before the build had started.** The check matched the agent reading build.sh. The script now
   leaves a mark when it really starts, and the stop waits for it.
3. **A stopped command ran on, on Windows.** The agent ran `timeout 550 bash build.sh`, and MSYS's `timeout` breaks
   the Windows parent links that `taskkill /T` follows, so the build finished after Stop all. A harness bug for any
   session on Windows, not only the swarm.

   The fix: every command carries a tag in its environment, and a stop finds every process with the tag through
   MSYS's /proc, sweeping three times.

   It is not complete. On a loaded machine about 1 stop in 4 still misses a process, because MSYS cannot always read
   a busy process's environment. That test is marked as a known gap (todo); a Windows Job Object is the real fix.
4. **The agent on the laptop looked in the wrong folder.** The lead wrote its brief from its own folder
   ("/workspace") and the laptop agent found nothing. A placed agent is now told which computer it is on and its
   folder there.
5. **`machines` alone ran nowhere.** The lead passed `machines` with no items, and the agent ran once in the
   conversation's folder. `machines` with no items is now the same brief on each computer.
6. **The lead did not know the computers were there.** The agent tool now names the person's computers in its
   description.

## Deterministic tests

`test/machines.test.ts`:

- A cancel kills a running command's processes on the machine.
- A job a restarted server no longer knows is stopped at the next poll.
- A fenced companion stops everything and takes no work.
- The policy is checked on the machine, whatever the server says.
- The capacity cap holds: 6 commands at once run 2 at a time.
- Placement works, and Stop all reaches the laptop.
- At stakes, checks that ran only on the worker's machine do not accept its work.
- Machines without items mean the same brief on each.

`test/companion-bundle.test.ts`:

- The real bundle's `policy` command works.
- Its lease holds: with the server gone mid-command, the companion stopped the command itself within 40 s and took
  no more work.
