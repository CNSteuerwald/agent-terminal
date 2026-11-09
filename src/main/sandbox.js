'use strict';
// Docker Sandboxes (sbx) integration.
// The sbx TUI opens sandboxes in "an external terminal". On Windows, when WT_SESSION is set it runs
//   wt.exe -w new nt -- <sbx.exe> --ui-origin=tui run --name <sandbox>
// so the sbx tab gets our own wt.exe (src/shim/wt.cs) first on PATH, which forwards the request
// over a named pipe and we open the session as a tab instead.
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const TOKEN = crypto.randomBytes(16).toString('hex');
const PIPE = `agent-terminal-${process.pid}`;

function which(cmd) {
  return new Promise(resolve => execFile(IS_WIN ? 'where.exe' : 'which', [cmd], { windowsHide: true, timeout: 3000 },
    (err, out) => resolve(err ? null : out.split(/\r?\n/)[0].trim() || null)));
}

// wt.exe arguments -> the sbx arguments to run, or null if it isn't an sbx launch.
function parseWtLaunch(args) {
  const i = args.indexOf('--');
  const cmd = i >= 0 ? args.slice(i + 1) : [];
  if (!cmd.length || !/^sbx(\.exe)?$/i.test(cmd[0].split(/[\\/]/).pop())) return null;
  const sbxArgs = cmd.slice(1);
  const n = sbxArgs.indexOf('--name');
  return { args: sbxArgs, name: n >= 0 ? sbxArgs[n + 1] || null : null };
}

// Compiles the wt.exe stand-in into dir. Resolves to the directory, or null when unavailable.
function ensureShim(dir) {
  if (!IS_WIN) return Promise.resolve(null);
  // shortcut: compiles from the source tree; a packaged (asar) build must ship wt.cs unpacked or a prebuilt wt.exe.
  const src = path.join(__dirname, '..', 'shim', 'wt.cs');
  const exe = path.join(dir, 'wt.exe');
  try {
    if (fs.statSync(exe).mtimeMs >= fs.statSync(src).mtimeMs) return Promise.resolve(dir);
  } catch { /* not built yet */ }
  const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  fs.mkdirSync(dir, { recursive: true });
  return new Promise(resolve => execFile(csc, ['-nologo', `-out:${exe}`, src], { windowsHide: true, timeout: 60000 },
    err => resolve(err ? null : dir)));
}

// Listens for wt.exe stand-in requests; onLaunch({ args, name, cwd }) for each valid one. Returns the server.
function listen(onLaunch) {
  if (!IS_WIN) return;
  return net.createServer(sock => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', d => { buf += d; if (buf.length > 65536) sock.destroy(); });
    sock.on('error', () => {});
    sock.on('end', () => {
      const [token, cwd, ...args] = buf.split('\n').slice(0, -1);
      if (token !== TOKEN) return; // only processes started from our sbx tab know the token
      const launch = parseWtLaunch(args);
      if (launch) onLaunch({ ...launch, cwd });
    });
  }).listen(`\\\\.\\pipe\\${PIPE}`);
}

// Extra environment for the sbx TUI pane so its "External terminal" option reaches us.
function shimEnv(env, shimDir) {
  if (!shimDir) return env;
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  return {
    ...env, [pathKey]: `${shimDir};${env[pathKey] || ''}`,
    WT_SESSION: 'agent-terminal', AGENT_TERMINAL_PIPE: PIPE, AGENT_TERMINAL_TOKEN: TOKEN,
  };
}

function list(sbxPath) {
  if (!sbxPath) return Promise.resolve([]);
  return new Promise(resolve => execFile(sbxPath, ['ls', '--json'], { windowsHide: true, timeout: 10000 }, (err, out) => {
    try { resolve(err ? [] : JSON.parse(out)); } catch { resolve([]); }
  }));
}

module.exports = { which, parseWtLaunch, ensureShim, listen, shimEnv, list };
