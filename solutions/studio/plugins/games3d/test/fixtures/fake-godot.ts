import fs from 'node:fs/promises';
import path from 'node:path';
import { tempDir, testPicture } from '@harness/plugin-sdk/testing';

/**
 * A stand-in for Godot 4 (a sh script) that understands the command lines the
 * games3d plugin builds: import, the check script, frames for --write-movie,
 * --selftest (SELFTEST PASS when a script says so, a push_error when one says
 * FAKE_FAIL) and --export-release (FAKE_NO_TEMPLATES=1: "No export template
 * found"). Every call is appended to calls.log beside it. For HARNESS_GODOT.
 */
export async function fakeGodot(): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await tempDir('hw-fake-godot-');
  const file = path.join(dir, 'godot');
  const log = path.join(dir, 'calls.log');
  const frame = testPicture(32, 24).toString('base64');
  const script = [
    '#!/bin/sh',
    `echo "$*" >> '${log.split(path.sep).join('/')}'`,
    'proj=.; movie=; frames=60; selftest=0; import=0; check=; out=',
    'while [ $# -gt 0 ]; do',
    '  case "$1" in',
    '    --path) proj=$2; shift;;',
    '    --write-movie) movie=$2; shift;;',
    '    --quit-after) frames=$2; shift;;',
    '    --import) import=1;;',
    '    --script) check=$2; shift;;',
    '    --export-release|--export-debug) out=$3; shift 2;;',
    '    --selftest) selftest=1;;',
    '  esac',
    '  shift',
    'done',
    'echo "Godot Engine v4.7.2.stable.fake"',
    '[ "$import" = 1 ] && exit 0',
    'if [ -n "$check" ]; then echo "HARNESS_CHECKED $(find "$proj" -name "*.gd" -o -name "*.tscn" | grep -v "/.godot/" | wc -l | tr -d " ")"; exit 0; fi',
    'if [ -n "$out" ]; then',
    '  if [ "${FAKE_NO_TEMPLATES:-}" = 1 ]; then echo "ERROR: Cannot export project with preset: No export template found at the expected path"; exit 1; fi',
    '  mkdir -p "$(dirname "$out")" && echo binary > "$out" && echo pack > "${out%.*}.pck"; exit 0',
    'fi',
    'if [ -n "$movie" ]; then',
    '  i=0',
    `  while [ $i -lt "$frames" ]; do printf '%s' '${frame}' | base64 -d > "\${movie%.png}$(printf '%08d' $i).png"; i=$((i+1)); done`,
    'fi',
    'if [ "$selftest" = 1 ]; then',
    '  if grep -rq FAKE_FAIL --include="*.gd" "$proj"; then printf "ERROR: selftest: the player did not move\\n   at: push_error (core/variant/variant_utility.cpp:1023)\\n   GDScript backtrace (most recent call first):\\n       [0] _physics_process (res://main.gd:9)\\n";',
    '  elif grep -rq "SELFTEST PASS" --include="*.gd" "$proj"; then echo "SELFTEST PASS"; fi',
    'fi',
    'exit 0',
    '',
  ].join('\n');
  await fs.writeFile(file, script, { mode: 0o755 });
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { bin: file.split(path.sep).join('/'), calls };
}
