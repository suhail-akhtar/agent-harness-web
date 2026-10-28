// Playing a web game: its folder is served on this computer (127.0.0.1) because a module game does not run from
// file://; the link loads the page and its modules; the same link while it is served; the build is preferred.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { tempDir } from '@harness/plugin-sdk/testing';
// @ts-expect-error plain JS module
import { playableDir, playUrl, stopAllPlaying } from '../lib-play.mjs';

test('play: the build folder served on 127.0.0.1; the page and its module load; the same link again; none without an index.html', async () => {
  const project = await tempDir();
  await fs.mkdir(path.join(project, 'build', 'web', 'src'), { recursive: true });
  await fs.writeFile(path.join(project, 'index.html'), 'source');
  await fs.writeFile(path.join(project, 'build', 'web', 'index.html'), '<script type="module" src="src/main.js"></script>');
  await fs.writeFile(path.join(project, 'build', 'web', 'src', 'main.js'), 'export const ok = 1;');
  try {
    const dir = playableDir(project);
    assert.equal(dir, path.join(project, 'build', 'web'), 'the build first');
    const url = await playUrl(dir);
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/index\.html$/);
    assert.match(await (await fetch(url)).text(), /type="module"/);
    const js = await fetch(new URL('src/main.js', url));
    assert.match(js.headers.get('content-type') ?? '', /javascript/);
    assert.equal(await playUrl(dir), url, 'one server per folder');
    assert.equal((await fetch(new URL('../index.html', url))).status, 200, 'paths are kept inside the folder');
    assert.equal(playableDir(await tempDir()), null);
  } finally { await stopAllPlaying(); }
});
