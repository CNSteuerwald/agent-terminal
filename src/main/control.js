'use strict';
// atx: the command-line and MCP interface to Agent Terminal, and agent hooks that feed its notifications.
//
// Every pane gets AGENT_TERMINAL_CTL_PIPE / _TOKEN / AGENT_TERMINAL_PANE and atx.exe on PATH (src/shim/atx.cs).
// atx relays its arguments here over a named pipe; this module parses them into commands, which the window
// that owns the pane carries out (renderer: runControl in app.js). Agents launched by the app also get:
//   - hooks (Claude Code --settings, Codex notify) that call `atx hook <agent>`, so the notification
//     center hears exactly why an agent stopped, not just that its output did;
//   - optionally the same commands as MCP tools (`atx mcp`), so agents can open and coordinate other agents.
// Pure functions are exported for tests; listen() and the file helpers need Windows / a writable folder.
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const TOKEN = crypto.randomBytes(24).toString('hex');
const PIPE = `agent-terminal-ctl-${process.pid}`;
const LEVELS = ['info', 'attention', 'done'];
const MAX_REQUEST = 1 << 20;

class UsageError extends Error {}

const USAGE = `atx: control Agent Terminal from its panes.

  atx notify [--level info|attention|done] [--title TEXT] MESSAGE
        Add a notification for this pane (default level: attention).
  atx status [--progress 0-100] TEXT     Show a status in this pane's header and the sidebar.
  atx status --clear                     Remove it.
  atx list [--json]                      List tabs and panes with their ids.
  atx open [--cwd DIR] [--agent ID | --shell PROFILE | --command NAME | --template NAME]
           [--prompt TEXT] [--title TEXT] [--background] [--json]
        Open a new tab group; prints the id of its agent (or first) pane.
  atx split [--pane ID] [--down] [--agent ID | --shell PROFILE | --command NAME] [--prompt TEXT] [--json]
        Add a pane next to this one (or --pane ID); prints its id.
  atx focus PANE                         Switch to a pane.
  atx read PANE [--lines N]              Print the last N lines (default 50) of a pane's screen.
  atx wait PANE [--timeout SECONDS] [--json]
        Wait until an agent pane finishes its turn, needs you, or exits (default timeout: 600).
        Prints done, attention, idle, exited or timeout (exit code 3), with the agent's message.
  atx send PANE [--no-enter] TEXT        Type into a pane.  (Settings → Notifications & control)
  atx close PANE                         Close a pane.      (Settings → Notifications & control)

PANE is a pane id from \`atx list\`, or "self". Agents launched by Agent Terminal report through hooks
(atx hook) automatically, and can get these commands as MCP tools (atx mcp).
`;

// ---------------------------------------------------------------- argument parsing
const VALUE_OPTS = new Set(['level', 'title', 'progress', 'cwd', 'agent', 'shell', 'command', 'template', 'prompt', 'pane', 'timeout', 'lines']);
const FLAG_OPTS = new Set(['json', 'clear', 'background', 'down', 'no-enter', 'help']);
const SHORT = { l: 'level', t: 'title', p: 'progress', n: 'lines', h: 'help' };

function splitArgs(args) {
  const opts = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { pos.push(...args.slice(i + 1)); break; }
    const m = a.match(/^--([a-z-]+)(?:=([\s\S]*))?$/) || a.match(/^-([a-z])$/);
    if (!m) { pos.push(a); continue; }
    const key = SHORT[m[1]] || m[1];
    if (FLAG_OPTS.has(key)) { opts[key] = true; continue; }
    if (!VALUE_OPTS.has(key)) throw new UsageError(`Unknown option ${a}.`);
    const v = m[2] ?? args[++i];
    if (v === undefined) throw new UsageError(`${a} needs a value.`);
    opts[key] = v;
  }
  return { opts, pos };
}

function paneRef(v, what = 'PANE') {
  if (v === undefined) throw new UsageError(`Missing ${what}. Run \`atx list\` to see pane ids.`);
  if (v === 'self' || v === '.') return 'self';
  if (!/^\d{1,9}$/.test(v)) throw new UsageError(`${what} must be a pane id from \`atx list\` (a number) or "self".`);
  return Number(v);
}

function intOpt(v, name, lo, hi, dflt) {
  if (v === undefined) return dflt;
  if (!/^\d+$/.test(String(v)) || Number(v) < lo || Number(v) > hi) throw new UsageError(`--${name} must be a number from ${lo} to ${hi}.`);
  return Number(v);
}

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// What to open in a new tab or pane: at most one of agent/shell/command/template.
function launchOpts(o, allowTemplate) {
  const picked = ['agent', 'shell', 'command', allowTemplate && 'template'].filter(k => k && o[k] !== undefined);
  if (picked.length > 1) throw new UsageError(`Use only one of ${picked.map(k => `--${k}`).join(', ')}.`);
  if (o.prompt !== undefined && picked[0] && picked[0] !== 'agent') throw new UsageError('--prompt goes with --agent.');
  const out = {};
  for (const k of ['agent', 'shell', 'command', 'template', 'title']) if (o[k] !== undefined) out[k] = clip(String(o[k]), 200);
  if (o.prompt !== undefined) {
    if (!o.prompt.trim()) throw new UsageError('--prompt is empty.');
    out.prompt = clip(o.prompt, 20000);
  }
  return out;
}

// argv (after "atx") -> a command for the window, or { help } / { version }. Throws UsageError.
function parseArgs(argv) {
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') return { help: true };
  if (name === 'version' || name === '--version') return { version: true };
  const { opts: o, pos } = splitArgs(rest);
  if (o.help) return { help: true };
  const text = () => pos.join(' ');
  switch (name) {
    case 'notify': {
      const level = o.level ?? 'attention';
      if (!LEVELS.includes(level)) throw new UsageError(`--level must be one of ${LEVELS.join(', ')}.`);
      if (!text().trim()) throw new UsageError('Missing MESSAGE.');
      return { cmd: 'notify', level, title: o.title ? clip(o.title, 120) : '', message: clip(text(), 2000), source: 'atx' };
    }
    case 'status':
      if (o.clear) return { cmd: 'status', clear: true };
      if (!text().trim() && o.progress === undefined) throw new UsageError('Missing TEXT (or --clear).');
      return { cmd: 'status', text: clip(text(), 200), progress: intOpt(o.progress, 'progress', 0, 100, null) };
    case 'list': return { cmd: 'list', json: !!o.json };
    case 'open': {
      if (o.cwd !== undefined && !String(o.cwd).trim()) throw new UsageError('--cwd is empty.');
      return { cmd: 'open', cwd: o.cwd, background: !!o.background, json: !!o.json, ...launchOpts(o, true) };
    }
    case 'split':
      return { cmd: 'split', target: o.pane !== undefined ? paneRef(o.pane, '--pane') : 'self', down: !!o.down, json: !!o.json, ...launchOpts(o, false) };
    case 'focus': return { cmd: 'focus', target: paneRef(pos[0]) };
    case 'read': return { cmd: 'read', target: paneRef(pos[0]), lines: intOpt(o.lines, 'lines', 1, 5000, 50) };
    case 'wait': return { cmd: 'wait', target: paneRef(pos[0]), timeout: intOpt(o.timeout, 'timeout', 1, 86400, 600), json: !!o.json };
    case 'send': {
      const target = paneRef(pos[0]);
      const t = pos.slice(1).join(' ');
      if (!t) throw new UsageError('Missing TEXT.');
      if (t.length > 100000) throw new UsageError('TEXT is too long (100,000 characters at most).');
      return { cmd: 'send', target, text: t, enter: !o['no-enter'] };
    }
    case 'close': return { cmd: 'close', target: paneRef(pos[0]) };
    default: throw new UsageError(`Unknown command "${name}".`);
  }
}

// ---------------------------------------------------------------- agent hooks
const firstPart = s => clip(String(s || '').trim().split(/\n\s*\n/)[0].replace(/\s+/g, ' '), 300);
const CLAUDE_ATTENTION = {
  permission_prompt: 'Needs your permission',
  elicitation_dialog: 'Has a question for you',
  elicitation_url_dialog: 'Has a question for you',
  agent_needs_input: 'Needs your input',
  idle_prompt: 'Waiting for your input',
};

// An agent hook's payload -> a command (notify / turn), or null to ignore it.
//   claude: Claude Code hook JSON on stdin (Notification, Stop, UserPromptSubmit).
//   codex:  Codex `notify` JSON as the last argument (agent-turn-complete).
function hookToCommand(agent, args, stdin) {
  let p;
  try { p = JSON.parse(agent === 'codex' ? args.at(-1) ?? stdin : stdin); } catch { return null; }
  if (!p || typeof p !== 'object') return null;
  if (agent === 'claude') {
    const ev = p.hook_event_name;
    if (ev === 'UserPromptSubmit') return { cmd: 'turn' };
    if (ev === 'Stop') return { cmd: 'notify', level: 'done', title: 'Finished', message: firstPart(p.last_assistant_message) || 'Finished its turn.', source: 'hook' };
    if (ev === 'Notification') {
      const type = String(p.notification_type || '');
      const title = CLAUDE_ATTENTION[type];
      if (title) return { cmd: 'notify', level: 'attention', title: p.title ? clip(String(p.title), 120) : title, message: firstPart(p.message) || title, source: 'hook' };
      if (type === 'agent_completed') return { cmd: 'notify', level: 'done', title: 'Finished', message: firstPart(p.message) || 'Finished.', source: 'hook' };
      return p.message ? { cmd: 'notify', level: 'info', title: p.title ? clip(String(p.title), 120) : 'Claude Code', message: firstPart(p.message), source: 'hook' } : null;
    }
    return null;
  }
  if (agent === 'codex' && p.type === 'agent-turn-complete') {
    return { cmd: 'notify', level: 'done', title: 'Finished', message: firstPart(p['last-assistant-message']) || 'Finished its turn.', source: 'hook' };
  }
  return null;
}

// ---------------------------------------------------------------- MCP (atx mcp)
const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const paneProp = { type: ['integer', 'string'], description: 'A pane id from list_panes, or "self" for your own pane.' };
const launchProps = {
  agent: { type: 'string', description: 'Agent id to run (see list_panes / Settings → Agents), e.g. "claude".' },
  shell: { type: 'string', description: 'Shell profile to run instead of an agent.' },
  command: { type: 'string', description: 'Command tab (Settings → Commands) to run instead of an agent.' },
  prompt: { type: 'string', description: 'First message for the agent (claude, codex, gemini).' },
};
const MCP_TOOLS = [
  { name: 'notify', description: 'Show a notification in Agent Terminal for your pane, e.g. when you need the user or finished a long task.',
    inputSchema: { type: 'object', properties: { message: { type: 'string' }, title: { type: 'string' }, level: { type: 'string', enum: LEVELS } }, required: ['message'] },
    toArgs: a => ['notify', ...(a.level ? ['--level', a.level] : []), ...(a.title ? ['--title', a.title] : []), '--', a.message] },
  { name: 'set_status', description: 'Show a short status (and optional progress) in your pane header and the sidebar. Empty text clears it.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, progress: { type: 'integer', minimum: 0, maximum: 100 } }, required: ['text'] },
    toArgs: a => (a.text || a.progress != null ? ['status', ...(a.progress != null ? ['--progress', String(a.progress)] : []), '--', a.text || ''] : ['status', '--clear']) },
  { name: 'list_panes', description: 'List Agent Terminal tabs and panes: ids, what runs in them, folders and whether each agent is working.',
    inputSchema: { type: 'object', properties: {} }, toArgs: () => ['list', '--json'] },
  { name: 'open_tab', description: 'Open a new tab group in a folder, optionally running an agent with a first prompt. Returns the new pane ids.',
    inputSchema: { type: 'object', properties: { cwd: { type: 'string', description: 'Folder (default: the current one).' }, ...launchProps, title: { type: 'string' }, background: { type: 'boolean', description: 'Open without switching to it.' } } },
    toArgs: a => ['open', '--json', ...opt(a, 'cwd'), ...launchArgs(a), ...opt(a, 'title'), ...(a.background ? ['--background'] : [])] },
  { name: 'split_pane', description: 'Add a pane next to yours (or another pane), optionally running an agent with a first prompt.',
    inputSchema: { type: 'object', properties: { pane: paneProp, down: { type: 'boolean' }, ...launchProps } },
    toArgs: a => ['split', '--json', ...(a.pane != null ? ['--pane', String(a.pane)] : []), ...(a.down ? ['--down'] : []), ...launchArgs(a)] },
  { name: 'wait_for_pane', description: "Wait until an agent pane finishes its turn, needs the user, or exits. Returns its state and last message.",
    inputSchema: { type: 'object', properties: { pane: paneProp, timeout_seconds: { type: 'integer', minimum: 1, maximum: 3600 } }, required: ['pane'] },
    toArgs: a => ['wait', '--json', String(a.pane), ...(a.timeout_seconds ? ['--timeout', String(a.timeout_seconds)] : [])] },
  { name: 'read_pane', description: "Read the last lines of a pane's screen (e.g. another agent's answer).",
    inputSchema: { type: 'object', properties: { pane: paneProp, lines: { type: 'integer', minimum: 1, maximum: 5000 } }, required: ['pane'] },
    toArgs: a => ['read', String(a.pane), ...(a.lines ? ['--lines', String(a.lines)] : [])] },
  { name: 'focus_pane', description: 'Switch the user\'s view to a pane.',
    inputSchema: { type: 'object', properties: { pane: paneProp }, required: ['pane'] }, toArgs: a => ['focus', String(a.pane)] },
  { name: 'send_to_pane', description: 'Type text into another pane (e.g. a follow-up for another agent). Off unless the user allows it in Settings.',
    inputSchema: { type: 'object', properties: { pane: paneProp, text: { type: 'string' }, enter: { type: 'boolean', description: 'Press Enter after (default true).' } }, required: ['pane', 'text'] },
    toArgs: a => ['send', String(a.pane), ...(a.enter === false ? ['--no-enter'] : []), '--', a.text] },
  { name: 'close_pane', description: 'Close a pane. Off unless the user allows it in Settings.',
    inputSchema: { type: 'object', properties: { pane: paneProp }, required: ['pane'] }, toArgs: a => ['close', String(a.pane)] },
];
function opt(a, k) { return a[k] != null && a[k] !== '' ? [`--${k}`, String(a[k])] : []; }
function launchArgs(a) { return [...opt(a, 'agent'), ...opt(a, 'shell'), ...opt(a, 'command'), ...opt(a, 'prompt')]; }

// One JSON-RPC message -> the reply line ('' for notifications). runArgv(argv) -> { code, text }.
async function handleMcp(line, runArgv, version) {
  let msg;
  try { msg = JSON.parse(line); } catch { return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  const { id, method, params = {} } = msg;
  if (id === undefined || id === null) return ''; // notifications (initialized, cancelled) need no answer
  const ok = result => JSON.stringify({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: MCP_VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : MCP_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-terminal', version },
        instructions: 'You are running inside Agent Terminal. These tools open and coordinate tabs and panes (for example another agent working on a subtask), report status, and notify the user.',
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: MCP_TOOLS.map(({ toArgs, ...t }) => t) });
    case 'tools/call': {
      const tool = MCP_TOOLS.find(t => t.name === params.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params.name}`);
      let argv;
      try { argv = tool.toArgs(params.arguments || {}); } catch { return fail(-32602, 'Invalid arguments'); }
      if (argv.some(a => typeof a !== 'string')) return ok({ content: [{ type: 'text', text: 'Missing a required argument.' }], isError: true });
      const r = await runArgv(argv);
      return ok({ content: [{ type: 'text', text: r.text.trim() || (r.code === 0 ? 'OK' : 'Failed') }], isError: r.code !== 0 });
    }
    default: return fail(-32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------- output
function formatList(r) {
  if (!r.tabs.length) return 'No tabs.';
  return r.tabs.map(t => [
    `${t.active ? '*' : ' '} tab ${t.id}  ${t.title}  ${t.cwd || ''}`.trimEnd(),
    ...t.panes.map(p => `    ${String(p.id ?? '-').padStart(4)}  ${p.kind.padEnd(7)}  ${p.name}${p.state ? `  [${p.state}]` : ''}${p.status ? `  ${p.status}` : ''}`),
  ].join('\n')).join('\n');
}

function format(c, r) {
  if (c.json) return JSON.stringify(r, null, 2);
  switch (c.cmd) {
    case 'list': return formatList(r);
    case 'open': case 'split': return String(r.pane ?? '');
    case 'wait': return [r.state, r.message].filter(Boolean).join(': ');
    case 'read': return r.text;
    default: return '';
  }
}

// ---------------------------------------------------------------- requests
// req: { pane, cwd, argv, stdin } from atx. exec(command) runs it in the owning window and resolves to its
// result (throwing an Error with a message for the user). Resolves to { code, text } for atx.
async function run(req, { exec, allowInput, version }) {
  const argv = Array.isArray(req.argv) ? req.argv.map(String) : [];
  const caller = /^\d+$/.test(String(req.pane || '')) ? Number(req.pane) : null;
  const call = async (c, extra = {}) => {
    if ((c.cmd === 'send' || c.cmd === 'close') && !allowInput) {
      throw new Error(`atx ${c.cmd} is turned off. Allow it in Settings → Notifications & control ("Let atx and agents type into and close panes").`);
    }
    const resolved = { ...c, ...extra, caller };
    if (c.cmd === 'open') {
      // Relative to where atx ran, like any command-line tool.
      const dir = path.resolve(String(req.cwd || process.cwd()), c.cwd ?? '.');
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { /* missing */ }
      if (!isDir) throw new Error(`No such folder: ${dir}`);
      resolved.cwd = dir;
    }
    if (resolved.target === 'self') {
      if (caller == null) throw new Error('"self" only works inside an Agent Terminal pane.');
      resolved.target = caller;
    }
    return exec(resolved);
  };
  const runArgv = async args => {
    let c;
    try { c = parseArgs(args); } catch (e) { return { code: 2, text: e instanceof UsageError ? `${e.message}\n\n${USAGE}` : e.message }; }
    if (c.help) return { code: 0, text: USAGE };
    if (c.version) return { code: 0, text: `atx (Agent Terminal ${version})` };
    try {
      const r = await call(c);
      return { code: c.cmd === 'wait' && r.state === 'timeout' ? 3 : 0, text: format(c, r) };
    } catch (e) { return { code: 1, text: e.message }; }
  };
  if (argv[0] === 'hook') {
    const c = hookToCommand(argv[1], argv.slice(2), typeof req.stdin === 'string' ? req.stdin : '');
    if (c && caller != null) await call(c).catch(() => {});
    return { code: 0, text: '' };
  }
  if (argv[0] === 'mcp') return { code: 0, text: await handleMcp(String(req.stdin || ''), runArgv, version) };
  return runArgv(argv);
}

// Serves atx requests. handle(req) -> { code, text }. Returns the server.
function listen(handle) {
  if (process.platform !== 'win32') return null;
  const server = net.createServer(sock => {
    let buf = '';
    let done = false;
    sock.setEncoding('utf8');
    sock.on('error', () => {});
    const reply = (code, text) => { if (!sock.destroyed) sock.end(`${code}\n${text}`); };
    sock.on('data', async d => {
      if (done) return;
      buf += d;
      if (buf.length > MAX_REQUEST) { done = true; return reply(1, 'Request too large.'); }
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      done = true;
      let req;
      try { req = JSON.parse(buf.slice(0, nl)); } catch { return reply(1, 'Malformed request.'); }
      const token = Buffer.from(String(req?.token || ''));
      if (token.length !== TOKEN.length || !crypto.timingSafeEqual(token, Buffer.from(TOKEN))) return reply(1, 'Not authorized.');
      try {
        const r = await handle(req);
        reply(r.code, r.text);
      } catch (e) { reply(1, e.message || 'Failed.'); }
    });
  });
  server.on('error', () => {});
  server.listen(`\\\\.\\pipe\\${PIPE}`);
  return server;
}

// Environment for a pane's process: atx on PATH and how to reach the app.
function paneEnv(env, paneId, binDir) {
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return {
    ...env,
    ...(binDir ? { [pathKey]: `${binDir}${path.delimiter}${env[pathKey] || ''}` } : {}),
    AGENT_TERMINAL_CTL_PIPE: PIPE, AGENT_TERMINAL_CTL_TOKEN: TOKEN, AGENT_TERMINAL_PANE: String(paneId),
  };
}

// ---------------------------------------------------------------- agent launch integration
// Writes the files agents are pointed at: Claude Code hook settings and the MCP server config.
function writeAgentFiles(dir, atxExe) {
  fs.mkdirSync(dir, { recursive: true });
  const exe = atxExe.replace(/\\/g, '/'); // forward slashes work in both cmd and bash, which run hooks
  const hook = { type: 'command', command: `"${exe}" hook claude`, timeout: 10 };
  const files = {
    claudeSettings: path.join(dir, 'claude-hooks.json'),
    mcp: path.join(dir, 'mcp.json'),
  };
  fs.writeFileSync(files.claudeSettings, JSON.stringify({
    hooks: { Notification: [{ hooks: [hook] }], Stop: [{ hooks: [hook] }], UserPromptSubmit: [{ hooks: [hook] }] },
  }, null, 2));
  fs.writeFileSync(files.mcp, JSON.stringify({ mcpServers: { 'agent-terminal': { type: 'stdio', command: atxExe, args: ['mcp'] } } }, null, 2));
  return files;
}

// Extra command-line arguments for an agent launched in a pane, by which program its command runs.
// codexHasNotify: the user's ~/.codex/config.toml sets its own notify, which ours would replace.
function agentArgs(command, { atxExe, files, hooks, tools, codexHasNotify }) {
  if (!atxExe || !files) return '';
  const prog = String(command).trim().split(/\s+/)[0].split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/, '');
  const q = p => `"${p}"`;
  const exe = atxExe.replace(/\\/g, '/');
  const tomlStr = s => (s.includes("'") ? null : `'${s}'`); // TOML literal string; quotes inside can't be written in cmd
  const out = [];
  if (prog === 'claude') {
    if (hooks) out.push('--settings', q(files.claudeSettings));
    if (tools) out.push('--mcp-config', q(files.mcp));
  } else if (prog === 'codex') {
    const e = tomlStr(exe);
    if (hooks && e && !codexHasNotify) out.push('-c', q(`notify=[${e},'hook','codex']`));
    if (tools && e) out.push('-c', q(`mcp_servers.agent_terminal.command=${e}`), '-c', q("mcp_servers.agent_terminal.args=['mcp']"));
  } else if (prog === 'copilot') {
    if (tools) out.push('--additional-mcp-config', q(`@${files.mcp}`));
  }
  return out.join(' ');
}

module.exports = {
  TOKEN, PIPE, USAGE, UsageError, MCP_TOOLS,
  parseArgs, hookToCommand, handleMcp, format, run, listen, paneEnv, writeAgentFiles, agentArgs,
};
