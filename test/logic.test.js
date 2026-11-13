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

test('model ids get short display names', () => {
  assert.equal(info.prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(info.prettyModel('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(info.prettyModel('claude-haiku-5-5[1m]'), 'Haiku 5.5 (1M)');
  assert.equal(info.prettyModel('gpt-5-codex'), 'gpt-5-codex');
  assert.equal(info.prettyModel(null), null);
});

test('detected shell profiles follow the default color scheme', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ colorScheme: 'Solarized Dark' }));
  const { settings: s } = settings.load(file);
  assert.ok(s.profiles.every(p => !p.colorScheme));
  assert.deepEqual(s.templates, []);
});

test('PATH is read back from reg query output', async () => {
  const out = '\r\nHKEY_CURRENT_USER\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\bin;C:\tools\r\n\r\n';
  assert.equal(settings.regValue(out), '%USERPROFILE%\bin;C:\tools');
  assert.equal(settings.regValue('ERROR: The system was unable to find the specified registry key or value.'), '');
  if (process.platform === 'win32') assert.match(await settings.freshPath(), /system32/i);
});

test('command tabs run their command in the shell; incomplete entries are dropped', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-terminal-')), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ commands: [{ name: 'Lazy Docker', command: 'lazydocker' }, { name: 'broken' }] }));
  const s = settings.load(file).settings;
  assert.deepEqual(s.commands.map(c => c.name), ['Lazy Docker']);
  assert.match([].concat(settings.commandLaunch(s, 'Lazy Docker').args).join(' '), /lazydocker/);
  assert.equal(settings.commandLaunch(s, 'broken'), null);
});

test('context and cost from Claude Code transcript lines', () => {
  const usage = { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 1000,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } };
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, 1 h cache write at 2x input
  assert.equal(info.messageCost('claude-opus-5-5', usage).toFixed(4), (0.004 + 0.02 + 0.2 + 0.008).toFixed(4));
  assert.equal(info.messageCost('claude-opus-5-5', { ...usage, speed: 'fast' }).toFixed(4), (2 * 0.232).toFixed(4));
  assert.equal(info.messageCost('some-other-model', usage), 0);

  const c = { costs: new Map(), last: null };
  const line = (id, u, extra = {}) => JSON.stringify({ type: 'assistant', ...extra, message: { id, model: 'claude-opus-5-5', usage: u } });
  info.addUsageLine(c, line('a', usage));
  info.addUsageLine(c, line('a', usage)); // same message, another content block
  info.addUsageLine(c, line('b', { input_tokens: 5, output_tokens: 0 }, { isSidechain: true }));
  assert.equal(c.costs.size, 2);
  assert.equal(c.last.context, 1000 + 1e6 + 1000); // sidechain lines don't move the main context
  info.addUsageLine(c, 'not json "usage"');
});
