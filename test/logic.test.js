'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Keys = require('../src/renderer/keys');
const info = require('../src/main/info');
const settings = require('../src/main/settings');

test('key events map to readable combos regardless of shift', () => {
  const ev = (code, mods = {}) => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });
  assert.equal(Keys.eventToKey(ev('KeyT', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+t');
  assert.equal(Keys.eventToKey(ev('Period', { ctrlKey: true, shiftKey: true })), 'ctrl+shift+.');
  assert.equal(Keys.eventToKey(ev('Digit3', { ctrlKey: true, altKey: true })), 'ctrl+alt+3');
  assert.equal(Keys.eventToKey(ev('F11')), 'f11');
  assert.equal(Keys.eventToKey(ev('ShiftLeft', { shiftKey: true })), null);
});

test('user-typed combos normalize', () => {
  assert.equal(Keys.normalize('Shift+Ctrl+T'), 'ctrl+shift+t');
  assert.equal(Keys.normalize('ctrl+plus'), 'ctrl+=');
  assert.equal(Keys.normalize('ctrl++'), 'ctrl+=');
  assert.equal(Keys.normalize('ctrl+shift+period'), 'ctrl+shift+.');
});

test('git porcelain v2 parsing', () => {
  const out = '# branch.oid abc\n# branch.head main\n# branch.upstream origin/main\n# branch.ab +2 -1\n1 .M N... 100644 100644 100644 a b file.js\n? new.txt\n';
  assert.deepEqual(info.parseGitStatus(out), { branch: 'main', ahead: 2, behind: 1, changes: 2 });
  assert.deepEqual(info.parseGitStatus('# branch.head feature\r\n'), { branch: 'feature', ahead: 0, behind: 0, changes: 0 });
});

test('claude project dir encoding matches Claude Code', () => {
  assert.ok(info.claudeProjectDir('C:\\Dev').endsWith(path.join('projects', 'C--Dev')));
  assert.ok(info.claudeProjectDir('/home/me/my.repo').endsWith(path.join('projects', '-home-me-my-repo')));
});

test('model detection from transcripts and commands', () => {
  const jsonl = '{"message":{"model":"claude-sonnet-5-5"}}\n{"message":{"model":"claude-opus-5-5","content":"say \\"model\\":\\"fake\\""}}\n{"message":{"model":"<synthetic>"}}\n';
  assert.equal(info.lastModel(jsonl), 'claude-opus-5-5');
  assert.equal(info.modelFromCommand('claude --model opus --continue'), 'opus');
  assert.equal(info.modelFromCommand('gemini -m gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(info.modelFromCommand('codex --model="gpt-5 codex"'), 'gpt-5 codex');
  assert.equal(info.modelFromCommand('codex --model "gpt-5"'), 'gpt-5');
  assert.equal(info.modelFromCommand('claude'), null);
});

test('settings merge, patch and reset', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-')), 'settings.json');
  let { settings: s, error } = settings.load(file);
  assert.equal(error, null);
  assert.ok(s.profiles.length > 0);
  assert.equal(s.defaultProfile, s.profiles[0].name);
  assert.ok(s.schemes.some(x => x.name === 'Campbell'));

  settings.update(file, { agents: [{ id: 'claude', command: 'claude --model opus' }], keybindings: { newTab: 'ctrl+t' } });
  settings.update(file, { agents: [{ id: 'claude', colorScheme: 'Dimidium' }], tabMetadata: { git: false } });
  s = settings.load(file).settings;
  const claude = s.agents.find(a => a.id === 'claude');
  assert.equal(claude.command, 'claude --model opus');
  assert.equal(claude.colorScheme, 'Dimidium');
  assert.equal(claude.name, 'Claude Code');
  assert.equal(s.tabMetadata.git, false);
  assert.equal(s.tabMetadata.directory, true);

  settings.update(file, { keybindings: { newTab: null } });
  assert.ok(!('newTab' in settings.load(file).settings.keybindings));

  fs.writeFileSync(file, '{ broken');
  ({ settings: s, error } = settings.load(file));
  assert.match(error, /settings\.json/);
  assert.equal(s.defaultAgent, 'claude');
});

test('shells get cwd reporting; agents resume on restore', () => {
  const s = {
    profiles: [
      { name: 'ps', commandline: String.raw`C:\x\powershell.exe`, args: ['-NoLogo'] },
      { name: 'ps-own', commandline: 'pwsh', args: ['-Command', 'echo hi'] },
      { name: 'cmd', commandline: String.raw`C:\x\cmd.exe` },
    ],
    agents: [{ id: 'claude', command: 'claude --model opus', resumeArgs: '--continue' }, { id: 'codex', command: 'codex' }],
  };
  const ps = settings.shellLaunch(s, 'ps');
  assert.deepEqual(ps.args.slice(0, 3), ['-NoLogo', '-NoExit', '-EncodedCommand']);
  const script = Buffer.from(ps.args[3], 'base64').toString('utf16le');
  assert.match(script, /\]9;9;/);
  assert.match(script, /function global:prompt/);
  assert.deepEqual(settings.shellLaunch(s, 'ps-own').args, ['-Command', 'echo hi']);
  assert.ok(settings.shellLaunch(s, 'cmd').env.PROMPT.startsWith(String.raw`$e]9;9;$P$e\$P`));

  const cmdline = l => [].concat(l.args).join(' ');
  assert.match(cmdline(settings.agentLaunch(s, 'claude', true)), /claude --model opus --continue \|\| claude --model opus/);
  assert.doesNotMatch(cmdline(settings.agentLaunch(s, 'claude', false)), /--continue/);
  assert.doesNotMatch(cmdline(settings.agentLaunch(s, 'codex', true)), /--continue/);
});
