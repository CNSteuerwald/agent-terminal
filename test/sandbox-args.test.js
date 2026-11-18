'use strict';
const test = require('node:test');
const assert = require('node:assert');
const A = require('../src/shared/sandbox-args');
const sandbox = require('../src/main/sandbox');

test('sandbox names follow sbx rules', () => {
  for (const ok of ['ab', 'my-sandbox', 'CNH', 'team.api-1', 'a'.repeat(63)]) assert.equal(A.nameError(ok), '', ok);
  assert.match(A.nameError(''), /Enter a name/);
  assert.match(A.nameError('a'), /2 to 63/);
  assert.match(A.nameError('a'.repeat(64)), /2 to 63/);
  assert.match(A.nameError('bad name!'), /letters, numbers/);
  assert.match(A.nameError('-lead'), /start and end/);
  assert.match(A.nameError('trail-'), /start and end/);
  assert.match(A.nameError('a..b'), /start and end/);
  assert.match(A.nameError('a.-b'), /start and end/);
  assert.match(A.nameError('Default'), /reserved/);
  assert.match(A.nameError('cnh', ['CNH', 'Test']), /already exists/);
});

test('default name is <agent>-<first workspace folder>, made valid', () => {
  assert.equal(A.defaultName('claude', [{ path: String.raw`C:\Dev\agent-terminal` }]), 'claude-agent-terminal');
  assert.equal(A.defaultName('codex', [{ path: '/home/me/My Project!/' }]), 'codex-My-Project');
  assert.equal(A.defaultName('shell', []), 'shell-sandbox');
  const long = A.defaultName('claude', [{ path: `C:\\${'x'.repeat(80)}` }]);
  assert.equal(long.length, 63);
  assert.equal(A.nameError(long), '');
});

test('create args put flags first, then the agent and workspaces', () => {
  assert.deepEqual(A.createArgs({
    name: 'demo', agent: 'claude', kits: ['org/kit:1', 'git+https://x/y.git#ref=v1&dir=k'],
    workspaces: [{ path: String.raw`C:\Dev\app`, readOnly: false }, { path: String.raw`C:\Docs`, readOnly: true }],
  }), ['create', '--name', 'demo', '--kit', 'org/kit:1', '--kit', 'git+https://x/y.git#ref=v1&dir=k', 'claude', String.raw`C:\Dev\app`, String.raw`C:\Docs:ro`]);
  assert.deepEqual(A.createArgs({ name: 'demo', agent: 'shell', workspaces: [{ path: '/w' }] }), ['create', '--name', 'demo', 'shell', '/w']);
});

test('validate refuses anything that could become a stray sbx flag', () => {
  const good = { name: 'demo', agent: 'claude', kits: [], workspaces: [{ path: 'C:\\w' }] };
  assert.equal(A.validate(good), good);
  const bad = patch => assert.throws(() => A.validate({ ...good, ...patch }));
  bad({ name: '--rm' });
  bad({ agent: '--cloud' });
  bad({ agent: 'not-an-agent' });
  bad({ kits: ['--rm'] });
  bad({ kits: [' '] });
  bad({ kits: 'org/kit' });
  bad({ workspaces: [] });
  bad({ workspaces: [{ path: '--privileged' }] });
  bad({ workspaces: [{}] });
  assert.throws(() => A.validate(null), /Enter a name/);
  assert.throws(() => A.validate(good, ['DEMO']), /already exists/);
});

test('remembered kits: most recent first, no duplicates, capped', () => {
  assert.deepEqual(A.rememberKits(['a', 'b', 'c'], ['c', 'd']), ['c', 'd', 'a', 'b']);
  assert.deepEqual(A.rememberKits(undefined, ['a']), ['a']);
  assert.equal(A.rememberKits(Array.from({ length: 40 }, (_, i) => `k${i}`), ['new']).length, 30);
});

test('command preview quotes only what needs it', () => {
  assert.equal(A.preview(['create', '--name', 'demo', 'claude', String.raw`C:\My Docs:ro`]),
    String.raw`sbx create --name demo claude "C:\My Docs:ro"`);
});

test('sbx errors are reduced to their message', () => {
  const out = '  ○ claude — now ships as a kit; resolving docker.io/sbx/claude:latest\r\nerror: name must match regexp ^[a-zA-Z0-9][a-zA-Z0-9.-]+$: bad name!\r\n';
  assert.equal(sandbox.errorMessage(out), 'name must match regexp ^[a-zA-Z0-9][a-zA-Z0-9.-]+$: bad name!');
  assert.equal(sandbox.errorMessage('first\nlast line\n'), 'last line');
  assert.equal(sandbox.errorMessage(''), 'sbx failed.');
});

test('create validates before running sbx and reports its failure', async () => {
  await assert.rejects(sandbox.create(null, {}), /not found/);
  // node stands in for sbx: `ls --json` fails (no existing sandboxes), and the create itself fails loudly.
  await assert.rejects(sandbox.create(process.execPath, { name: 'x', agent: 'claude', kits: [], workspaces: [{ path: '.' }] }), /2 to 63/);
  await assert.rejects(sandbox.create(process.execPath, { name: 'demo', agent: 'claude', kits: [], workspaces: [{ path: '.' }] }), /--no-input/);
});
