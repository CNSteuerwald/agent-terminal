'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sandbox = require('../src/main/sandbox');

test('parses the wt.exe launch the sbx TUI performs', () => {
  const args = ['-w', 'new', 'nt', '--', String.raw`C:\Users\me\AppData\Local\DockerSandboxes\bin\sbx.exe`, '--ui-origin=tui', 'run', '--name', 'CNH'];
  assert.deepEqual(sandbox.parseWtLaunch(args), { args: ['--ui-origin=tui', 'run', '--name', 'CNH'], name: 'CNH' });
  assert.equal(sandbox.parseWtLaunch(['-w', 'new', 'nt', '--', 'powershell.exe', '-c', 'calc']), null);
  assert.equal(sandbox.parseWtLaunch(['nt', 'sbx.exe']), null);
  assert.equal(sandbox.parseWtLaunch(['--', '/usr/local/bin/sbx', 'exec', '-it', 'box', 'bash']).name, null);
});

test('shim env prepends PATH without duplicating its key', () => {
  const env = sandbox.shimEnv({ Path: String.raw`C:\Windows` }, String.raw`C:\shim`);
  assert.equal(env.Path, String.raw`C:\shim;C:\Windows`);
  assert.ok(!('PATH' in env));
  assert.equal(env.WT_SESSION, 'agent-terminal');
  assert.deepEqual(sandbox.shimEnv({ Path: 'x' }, null), { Path: 'x' });
});

test('wt.exe stand-in forwards sbx launches over the pipe', { skip: process.platform !== 'win32' }, async () => {
  const dir = await sandbox.ensureShim(fs.mkdtempSync(path.join(os.tmpdir(), 'at-shim-')));
  assert.ok(dir, 'C# compiler should build the shim');
  let server;
  const got = new Promise(resolve => { server = sandbox.listen(resolve); });
  test.after?.(() => server.close());
  const env = sandbox.shimEnv({ ...process.env }, dir);
  await new Promise((res, rej) => execFile(path.join(dir, 'wt.exe'), ['-w', 'new', 'nt', '--', 'sbx.exe', 'run', '--name', 'demo'],
    { env, cwd: dir }, err => (err ? rej(err) : res())));
  const launch = await got;
  server.close();
  assert.deepEqual(launch.args, ['run', '--name', 'demo']);
  assert.equal(launch.name, 'demo');
  // Without the token (e.g. any other process) the shim is refused.
  await assert.rejects(new Promise((res, rej) => execFile(path.join(dir, 'wt.exe'), ['--', 'sbx.exe'], { env: { ...process.env } }, e => (e ? rej(e) : res()))));
});
