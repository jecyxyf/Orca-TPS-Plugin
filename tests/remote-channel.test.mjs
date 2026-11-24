import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { launchSsh } from '../src/remote-channel.mjs';
import { readTokensManagerBundle, tokensManagerBootstrap } from '../src/tokens-manager-client.mjs';

test('SSH bootstrap installs six files, uses the existing device ID and reuses the installed bundle', { timeout: 15_000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'tps-ssh-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, '.orca', 'tpsplugin'), bin = path.join(root, 'bin');
  await mkdir(bin, { recursive: true });
  const deviceGuid = randomUUID();
  await writeFile(path.join(root, 'device-guid'), deviceGuid);
  await writeFile(path.join(bin, 'version'), 'previous-bundle');
  await writeFile(path.join(bin, 'remote-collector.mjs'), 'old collector');
  const payload = await readTokensManagerBundle();

  async function subscribe(expectedVersion) {
    const child = spawn(process.execPath, ['--input-type=module', '-e', tokensManagerBootstrap], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, XDG_DATA_HOME: home }
    });
    t.after(() => { if (child.exitCode === null) child.kill(); });
    const exited = new Promise(resolve => child.once('exit', resolve));
    const reader = createInterface({ input: child.stdout, signal: AbortSignal.timeout(6000) });
    const lines = reader[Symbol.asyncIterator]();
    const send = value => child.stdin.write(JSON.stringify(value) + '\n');
    async function nextEvent(type) {
      for (let line = await lines.next(); !line.done; line = await lines.next()) {
        const message = JSON.parse(line.value);
        if (message.type === type) return message;
      }
      throw new Error('SSH bootstrap did not send ' + type);
    }
    try {
      assert.equal((await nextEvent('bootstrap')).version, expectedVersion);
      send(expectedVersion ? { version: expectedVersion } : payload);
      await nextEvent('installed');
      send({ type: 'hello', timeZone: 'UTC' });
      assert.equal((await nextEvent('ready')).deviceGuid, deviceGuid);
      const { packet } = await nextEvent('personal');
      assert.equal(packet.deviceGuid, deviceGuid);
      send({ type: 'unsubscribe' });
      assert.equal(await exited, 0);
    } finally {
      reader.close();
      child.stdin.end();
      if (child.exitCode === null) child.kill();
    }
  }

  await subscribe('');
  assert.deepEqual((await readdir(bin)).sort(), Object.keys(payload.files).sort());
  assert.equal(await readFile(path.join(root, 'bundle-version'), 'utf8'), payload.version);
  await subscribe(payload.version);
});

test('the current SSH transport rejects invalid destinations before spawning', () => {
  for (const destination of [
    { host: '../bad', username: 'fixture', port: 22 },
    { host: 'example.test', username: 'bad user', port: 22 },
    { host: 'example.test', username: 'fixture', port: 0 }
  ]) {
    assert.throws(() => launchSsh(destination, 'fixture', tokensManagerBootstrap), { message: 'ssh' });
  }
});
