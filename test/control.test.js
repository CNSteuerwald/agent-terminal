'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const control = require('../src/main/control');
const csc = require('../src/main/csc');
const settings = require('../src/main/settings');

const IS_WIN = process.platform === 'win32';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'at-ctl-'));

test('atx arguments parse into commands', () => {
  const p = control.parseArgs;
  assert.deepEqual(p([]), { help: true });
  assert.deepEqual(p(['help']), { help: true });
  assert.deepEqual(p(['notify', '--help']), { help: true });
  assert.deepEqual(p(['--version']), { version: true });
  assert.deepEqual(p(['notify', 'Tests', 'failed']), { cmd: 'notify', level: 'attention', title: '', message: 'Tests failed', source: 'atx' });
  assert.deepEqual(p(['notify', '-l', 'done', '--title=Build', '--', '--all green']), { cmd: 'notify', level: 'done', title: 'Build', message: '--all green', source: 'atx' });
  assert.deepEqual(p(['status', '--progress', '40', 'Running', 'tests']), { cmd: 'status', text: 'Running tests', progress: 40 });
  assert.deepEqual(p(['status', '--clear']), { cmd: 'status', clear: true });
  assert.deepEqual(p(['list', '--json']), { cmd: 'list', json: true });
  assert.deepEqual(p(['open', '--cwd', 'C:\\repo', '--agent', 'claude', '--prompt', 'fix "it" & ship']),
    { cmd: 'open', cwd: 'C:\\repo', background: false, json: false, agent: 'claude', prompt: 'fix "it" & ship' });
  assert.deepEqual(p(['split', '--down', '--shell', 'PowerShell']), { cmd: 'split', target: 'self', down: true, json: false, shell: 'PowerShell' });
  assert.deepEqual(p(['split', '--pane', '7']).target, 7);
  assert.deepEqual(p(['focus', '12']), { cmd: 'focus', target: 12 });
  assert.deepEqual(p(['read', 'self', '-n', '20']), { cmd: 'read', target: 'self', lines: 20 });
  assert.deepEqual(p(['wait', '3']), { cmd: 'wait', target: 3, timeout: 600, json: false });
  assert.deepEqual(p(['send', '3', '--no-enter', 'y']), { cmd: 'send', target: 3, text: 'y', enter: false });
  assert.deepEqual(p(['close', '.']), { cmd: 'close', target: 'self' });
  assert.equal(p(['notify', 'x'.repeat(5000)]).message.length, 2000);

  const bad = (argv, re) => assert.throws(() => p(argv), e => e instanceof control.UsageError && re.test(e.message), argv.join(' '));
  bad(['frobnicate'], /Unknown command/);
  bad(['notify'], /Missing MESSAGE/);
  bad(['notify', '--level', 'loud', 'x'], /--level must be/);
  bad(['notify', '--bogus', 'x'], /Unknown option/);
  bad(['notify', '--title'], /needs a value/);
  bad(['status'], /Missing TEXT/);
  bad(['status', '--progress', '140', 'x'], /0 to 100/);
  bad(['open', '--agent', 'claude', '--shell', 'cmd'], /only one of/);
  bad(['open', '--shell', 'cmd', '--prompt', 'hi'], /--prompt goes with --agent/);
  bad(['open', '--prompt', '  '], /--prompt is empty/);
  bad(['focus'], /Missing PANE/);
  bad(['focus', 'abc'], /pane id/);
  bad(['wait', '1', '--timeout', '0'], /--timeout/);
  bad(['send', '1'], /Missing TEXT/);
  bad(['read', '1', '--lines', '9999'], /--lines/);
});

test('Claude Code and Codex hook payloads become notifications', () => {
  const claude = o => control.hookToCommand('claude', [], JSON.stringify(o));
  assert.deepEqual(claude({ hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }),
    { cmd: 'notify', level: 'attention', title: 'Needs your permission', message: 'Claude needs your permission to use Bash', source: 'hook' });
  assert.equal(claude({ hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }).title, 'Waiting for your input');
  assert.equal(claude({ hook_event_name: 'Notification', notification_type: 'elicitation_dialog', message: 'q', title: 'Pick one' }).title, 'Pick one');
  assert.equal(claude({ hook_event_name: 'Notification', notification_type: 'auth_success', message: 'Signed in' }).level, 'info');
  assert.equal(claude({ hook_event_name: 'Notification', notification_type: 'agent_completed', message: 'All done' }).level, 'done');
  assert.equal(claude({ hook_event_name: 'Notification', notification_type: 'something_new' }), null);
  assert.deepEqual(claude({ hook_event_name: 'Stop', stop_hook_active: false, last_assistant_message: 'Fixed the flaky test.\n\nDetails:\n- one\n- two' }),
    { cmd: 'notify', level: 'done', title: 'Finished', message: 'Fixed the flaky test.', source: 'hook' });
  assert.equal(claude({ hook_event_name: 'Stop' }).message, 'Finished its turn.');
  assert.equal(claude({ hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(1000) }).message.length, 300);
  assert.deepEqual(claude({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }), { cmd: 'turn' });
  assert.equal(claude({ hook_event_name: 'SubagentStop' }), null);
  assert.equal(control.hookToCommand('claude', [], 'not json'), null);
  assert.equal(control.hookToCommand('claude', [], ''), null);
  assert.equal(control.hookToCommand('claude', [], 'null'), null);

  const codex = JSON.stringify({ type: 'agent-turn-complete', 'thread-id': 't', 'last-assistant-message': 'Renamed the module.', 'input-messages': ['rename'] });
  assert.deepEqual(control.hookToCommand('codex', [codex], ''), { cmd: 'notify', level: 'done', title: 'Finished', message: 'Renamed the module.', source: 'hook' });
  assert.equal(control.hookToCommand('codex', [JSON.stringify({ type: 'other' })], ''), null);
  assert.equal(control.hookToCommand('gemini', [], codex), null);
});

test('MCP server: handshake, tool list and calls', async () => {
  const calls = [];
  const runArgv = async argv => { calls.push(argv); return argv[0] === 'wait' ? { code: 3, text: 'timeout' } : { code: 0, text: argv[0] === 'list' ? '{"tabs":[]}' : '' }; };
  const ask = async msg => { const r = await control.handleMcp(JSON.stringify({ jsonrpc: '2.0', ...msg }), runArgv, '9.9.9'); return r && JSON.parse(r); };

  const init = await ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't' } } });
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.serverInfo.version, '9.9.9');
  assert.equal((await ask({ id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, '2025-06-18');
  assert.equal(await control.handleMcp(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }), runArgv, '1'), '');
  assert.deepEqual((await ask({ id: 3, method: 'ping' })).result, {});

  const tools = (await ask({ id: 4, method: 'tools/list' })).result.tools;
  assert.deepEqual(tools.map(t => t.name), ['notify', 'set_status', 'list_panes', 'open_tab', 'split_pane', 'wait_for_pane', 'read_pane', 'focus_pane', 'send_to_pane', 'close_pane']);
  assert.ok(tools.every(t => t.description && t.inputSchema?.type === 'object' && !('toArgs' in t)));

  const call = async (name, args) => (await ask({ id: 5, method: 'tools/call', params: { name, arguments: args } })).result;
  assert.deepEqual(await call('list_panes', {}), { content: [{ type: 'text', text: '{"tabs":[]}' }], isError: false });
  await call('open_tab', { cwd: 'C:\\repo', agent: 'claude', prompt: '--rm -rf', background: true });
  assert.deepEqual(calls.at(-1), ['open', '--json', '--cwd', 'C:\\repo', '--agent', 'claude', '--prompt', '--rm -rf', '--background']);
  await call('notify', { message: '--level done', level: 'info' });
  assert.deepEqual(calls.at(-1), ['notify', '--level', 'info', '--', '--level done']);
  await call('set_status', { text: '' });
  assert.deepEqual(calls.at(-1), ['status', '--clear']);
  await call('send_to_pane', { pane: 4, text: 'yes', enter: false });
  assert.deepEqual(calls.at(-1), ['send', '4', '--no-enter', '--', 'yes']);
  const waited = await call('wait_for_pane', { pane: 'self', timeout_seconds: 5 });
  assert.deepEqual(waited, { content: [{ type: 'text', text: 'timeout' }], isError: true });
  assert.equal((await call('notify', {})).isError, true); // missing message never reaches atx
  assert.equal((await ask({ id: 6, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
  assert.equal((await ask({ id: 7, method: 'resources/list' })).error.code, -32601);
  assert.equal(JSON.parse(await control.handleMcp('{oops', runArgv, '1')).error.code, -32700);
  assert.equal(JSON.parse(await control.handleMcp('[1]', runArgv, '1')).error.code, -32600);
});

test('requests: help, usage errors, self, the input switch, hooks and wait timeouts', async () => {
  const seen = [];
  const exec = async c => {
    seen.push(c);
    if (c.cmd === 'wait') return { state: 'timeout', message: '' };
    if (c.cmd === 'open') return { pane: 42 };
    if (c.cmd === 'list') return { tabs: [{ id: 1, title: 'repo', cwd: 'C:\\repo', active: true, panes: [{ id: 5, kind: 'agent', name: 'Claude Code', state: 'Working' }] }] };
    return {};
  };
  const run = (argv, extra = {}) => control.run({ pane: '5', cwd: os.tmpdir(), argv, ...extra }, { exec, allowInput: false, version: '1.2.3' });

  assert.equal((await run(['help'])).text, control.USAGE);
  assert.match((await run(['version'])).text, /1\.2\.3/);
  const usage = await run(['notify']);
  assert.equal(usage.code, 2);
  assert.match(usage.text, /Missing MESSAGE[\s\S]*atx notify/);

  assert.deepEqual(await run(['read', 'self']), { code: 0, text: undefined });
  assert.equal(seen.at(-1).target, 5);
  assert.equal(seen.at(-1).caller, 5);
  const outside = await control.run({ argv: ['focus', 'self'] }, { exec, allowInput: true, version: '1' });
  assert.deepEqual(outside, { code: 1, text: '"self" only works inside an Agent Terminal pane.' });

  const send = await run(['send', '3', 'hi']);
  assert.equal(send.code, 1);
  assert.match(send.text, /turned off/);
  assert.notEqual(seen.at(-1).cmd, 'send');
  const allowed = await control.run({ pane: '5', argv: ['send', '3', 'hi'] }, { exec, allowInput: true, version: '1' });
  assert.equal(allowed.code, 0);
  assert.deepEqual(seen.at(-1), { cmd: 'send', target: 3, text: 'hi', enter: true, caller: 5 });

  assert.deepEqual(await run(['wait', '3', '--timeout', '1']), { code: 3, text: 'timeout' });
  assert.equal((await run(['open', '--agent', 'claude'])).text, '42');
  assert.equal(seen.at(-1).cwd, os.tmpdir());
  const sub = tmp();
  fs.mkdirSync(path.join(sub, 'child'));
  await control.run({ pane: '5', cwd: sub, argv: ['open', '--cwd', 'child'] }, { exec, allowInput: false, version: '1' });
  assert.equal(seen.at(-1).cwd, path.join(sub, 'child'));
  const missing = await run(['open', '--cwd', path.join(sub, 'nope')]);
  assert.equal(missing.code, 1);
  assert.match(missing.text, /No such folder/);
  assert.match((await run(['list'])).text, /\* tab 1 {2}repo {2}C:\\repo\n {7}5 {2}agent {4}Claude Code {2}\[Working\]/);

  // Hooks: always succeed silently, even when the window fails or the payload is junk.
  const n = seen.length;
  assert.deepEqual(await run(['hook', 'claude'], { stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'Done.' }) }), { code: 0, text: '' });
  assert.deepEqual(seen.at(-1), { cmd: 'notify', level: 'done', title: 'Finished', message: 'Done.', source: 'hook', caller: 5 });
  assert.deepEqual(await run(['hook', 'claude'], { stdin: '{junk' }), { code: 0, text: '' });
  const failing = await control.run({ pane: '5', argv: ['hook', 'claude'], stdin: JSON.stringify({ hook_event_name: 'Stop' }) },
    { exec: async () => { throw new Error('boom'); }, allowInput: false, version: '1' });
  assert.deepEqual(failing, { code: 0, text: '' });
  assert.deepEqual(await control.run({ argv: ['hook', 'claude'], stdin: '{"hook_event_name":"Stop"}' }, { exec, version: '1' }), { code: 0, text: '' });
  assert.equal(seen.length, n + 1); // the junk payload and the paneless hook never reached the window

  const mcp = await run(['mcp'], { stdin: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'notify', arguments: { message: 'hi' } } }) });
  assert.equal(JSON.parse(mcp.text).result.isError, false);
  assert.equal(seen.at(-1).message, 'hi');
});

test('agents get hooks and tools by the program their command runs', () => {
  const dir = tmp();
  const exe = path.join(dir, 'bin', 'atx.exe');
  const files = control.writeAgentFiles(path.join(dir, 'control'), exe);
  const hooks = JSON.parse(fs.readFileSync(files.claudeSettings, 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks), ['Notification', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.Stop[0].hooks[0].command, `"${exe.replace(/\\/g, '/')}" hook claude`);
  assert.equal(hooks.Stop[0].hooks[0].timeout, 10);
  assert.deepEqual(JSON.parse(fs.readFileSync(files.mcp, 'utf8')), { mcpServers: { 'agent-terminal': { type: 'stdio', command: exe, args: ['mcp'] } } });

  const args = (cmd, o) => control.agentArgs(cmd, { atxExe: exe, files, hooks: true, tools: false, codexHasNotify: false, ...o });
  const fwd = exe.replace(/\\/g, '/');
  assert.equal(args('claude'), `--settings "${files.claudeSettings}"`);
  assert.equal(args('C:\\tools\\claude.exe --model opus', { tools: true }), `--settings "${files.claudeSettings}" --mcp-config "${files.mcp}"`);
  assert.equal(args('claude', { hooks: false }), '');
  assert.equal(args('codex'), `-c "notify=['${fwd}','hook','codex']"`);
  assert.equal(args('codex', { codexHasNotify: true }), '');
  assert.equal(args('codex.cmd', { hooks: false, tools: true }), `-c "mcp_servers.agent_terminal.command='${fwd}'" -c "mcp_servers.agent_terminal.args=['mcp']"`);
  assert.equal(args('codex', { atxExe: "C:\\Users\\o'brien\\atx.exe" }), ''); // can't be written as a TOML literal
  assert.equal(args('copilot', { tools: true }), `--additional-mcp-config "@${files.mcp}"`);
  assert.equal(args('copilot'), '');
  assert.equal(args('gemini', { tools: true }), '');
  assert.equal(args('claude', { atxExe: null }), '');
});

test('panes get atx on PATH and how to reach the app', () => {
  const env = control.paneEnv({ Path: 'C:\\Windows', X: '1' }, 17, 'C:\\at\\bin');
  assert.equal(env.Path, `C:\\at\\bin${path.delimiter}C:\\Windows`);
  assert.equal(env.AGENT_TERMINAL_PANE, '17');
  assert.equal(env.AGENT_TERMINAL_CTL_TOKEN, control.TOKEN);
  assert.equal(env.AGENT_TERMINAL_CTL_PIPE, control.PIPE);
  assert.equal(env.X, '1');
  assert.ok(!('PATH' in env));
  assert.equal(control.paneEnv({ PATH: 'x' }, 1, null).PATH, 'x');
});

test('starting prompts reach the agent intact, through cmd and npm-style .cmd shims', { skip: !IS_WIN }, async () => {
  const dir = tmp();
  // Stand-ins for an agent: an exe-like command (node) and an npm .cmd shim that forwards %*.
  const script = path.join(dir, 'echo.js');
  fs.writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  fs.writeFileSync(path.join(dir, 'agent.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
  const s = settings.load(path.join(dir, 'none.json')).settings;
  s.agents = [
    { id: 'direct', command: `"${process.execPath}" "${script}" --model x`, promptArg: '' },
    { id: 'shim', command: path.join(dir, 'agent.cmd'), promptArg: '-i' },
    { id: 'none', name: 'No Prompt', command: 'x' },
  ];
  const prompt = 'fix "the" bug & ship | now < 5 > 2 ^caret %PATH% !bang\'s\nsecond line';
  const viaCmd = spec => new Promise((res, rej) => {
    const p = spawn(spec.file, [spec.args], { windowsVerbatimArguments: true, env: { ...process.env, ...spec.env }, cwd: dir });
    let out = '';
    p.stdout.on('data', d => { out += d; });
    p.on('close', code => (code ? rej(new Error(`exit ${code}: ${out}`)) : res(JSON.parse(out))));
  });
  const expected = 'fix \'the\' bug & ship | now < 5 > 2 ^caret %PATH% !bang\'s second line';
  assert.deepEqual(await viaCmd(settings.agentLaunch(s, 'direct', false, { prompt })), ['--model', 'x', expected]);
  assert.deepEqual(await viaCmd(settings.agentLaunch(s, 'shim', false, { prompt })), ['-i', expected]);
  assert.deepEqual(await viaCmd(settings.agentLaunch(s, 'direct', false, { extra: '--settings "C:\\a b\\h.json"' })), ['--model', 'x', '--settings', 'C:\\a b\\h.json']);
  // The prompt comes before our options: Claude's --mcp-config takes several values and would swallow it.
  assert.deepEqual(await viaCmd(settings.agentLaunch(s, 'direct', false, { prompt: 'hi', extra: '--mcp-config "C:\\m.json"' })), ['--model', 'x', 'hi', '--mcp-config', 'C:\\m.json']);
  assert.throws(() => settings.agentLaunch(s, 'none', false, { prompt: 'hi' }), /can't be started with a prompt/);
});

test('atx relays commands, hooks and MCP over the pipe', { skip: !IS_WIN }, async t => {
  const exe = await csc.build('atx', tmp());
  assert.ok(exe, 'the C# compiler should build atx.exe');
  const got = [];
  const server = control.listen(async req => {
    got.push(req);
    return control.run(req, {
      exec: async c => (c.cmd === 'list' ? { tabs: [] } : c.cmd === 'open' ? { pane: 9 } : {}),
      allowInput: false, version: 't',
    });
  });
  t.after(() => server.close());
  const env = { ...process.env, ...control.paneEnv({}, 31, null) };
  const atx = (args, opts = {}) => new Promise(res => {
    const p = execFile(exe, args, { env: opts.env || env, cwd: opts.cwd || os.tmpdir(), timeout: 20000 }, (e, stdout, stderr) =>
      res({ code: e ? e.code : 0, stdout, stderr }));
    if (opts.stdin !== undefined) p.stdin.end(opts.stdin);
  });

  const notify = await atx(['notify', '--level', 'done', 'Build green ✓ — "quoted" & \\ back\\slash']);
  assert.deepEqual(notify, { code: 0, stdout: '', stderr: '' });
  assert.deepEqual(got.at(-1).argv, ['notify', '--level', 'done', 'Build green ✓ — "quoted" & \\ back\\slash']);
  assert.equal(got.at(-1).pane, '31');
  assert.equal(fs.realpathSync.native(got.at(-1).cwd), fs.realpathSync.native(os.tmpdir()));

  assert.equal((await atx(['open', '--agent', 'claude'])).stdout.trim(), '9');
  const usage = await atx(['notify']);
  assert.equal(usage.code, 2);
  assert.match(usage.stderr, /Missing MESSAGE/);
  const off = await atx(['send', '1', 'x']);
  assert.equal(off.code, 1);
  assert.match(off.stderr, /turned off/);

  const hook = await atx(['hook', 'claude'], { stdin: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'ok' }) });
  assert.deepEqual(hook, { code: 0, stdout: '', stderr: '' });
  assert.equal(JSON.parse(got.at(-1).stdin).hook_event_name, 'Stop');

  // A wrong token is refused; hooks still exit 0 and stay silent.
  const forged = { ...env, AGENT_TERMINAL_CTL_TOKEN: 'x'.repeat(48) };
  assert.match((await atx(['list'], { env: forged })).stderr, /Not authorized/);
  assert.deepEqual(await atx(['hook', 'claude'], { env: forged, stdin: '{}' }), { code: 0, stdout: '', stderr: '' });
  // Outside Agent Terminal, or with the app gone: a clear message, and hooks never block their agent.
  const outside = { ...process.env };
  delete outside.AGENT_TERMINAL_CTL_PIPE;
  assert.match((await atx(['list'], { env: outside })).stderr, /only works inside an Agent Terminal pane/);
  const gone = { ...env, AGENT_TERMINAL_CTL_PIPE: 'agent-terminal-ctl-nobody' };
  const t0 = Date.now();
  assert.deepEqual(await atx(['hook', 'claude'], { env: gone, stdin: '{}' }), { code: 0, stdout: '', stderr: '' });
  assert.ok(Date.now() - t0 < 5000, 'a hook gives up quickly when the app is gone');
  assert.match((await atx(['list'], { env: gone })).stderr, /not reachable/);

  // MCP: one JSON-RPC message per line, answered in order; notifications get no answer.
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_panes', arguments: {} } },
  ].map(m => JSON.stringify(m)).join('\n') + '\n';
  const mcp = await atx(['mcp'], { stdin: lines });
  const replies = mcp.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(replies.map(r => r.id), [1, 2]);
  assert.equal(replies[0].result.serverInfo.name, 'agent-terminal');
  assert.deepEqual(JSON.parse(replies[1].result.content[0].text), { tabs: [] });
});
