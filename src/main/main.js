'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const settings = require('./settings');
const sandbox = require('./sandbox');
const { getInfo } = require('./info');

const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS_FILE = path.join(app.getPath('userData'), 'defaults.json');
const SHIM_DIR = path.join(app.getPath('userData'), 'sbx-shim');
const SESSION_FILE = path.join(app.getPath('userData'), 'session.json');

let current = settings.load(SETTINGS_FILE);
// Open tabs per window, written on every change so they survive closing (or a crash).
const sessions = new Map(); // webContents id -> { tabs, active, bounds, maximized }
const restoring = new Map(); // webContents id -> the saved session this window should reopen
const ptys = new Map(); // id -> { proc, wc }
const tabCounts = new WeakMap(); // BrowserWindow -> open tab count
let nextPtyId = 1;
let sbxOwner = null; // webContents whose sbx tab receives "open in external terminal" requests

const sbxPath = () => sandbox.which(current.settings.sandboxCommand || 'sbx');

// Folder passed on the command line, e.g. `npm start -- C:\code\repo`.
function startupDir() {
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter(a => !a.startsWith('-'));
  const dir = args.at(-1);
  try { return dir && fs.statSync(dir).isDirectory() ? path.resolve(dir) : null; } catch { return null; }
}

function readSessions() {
  try { return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8')).filter(s => s?.tabs?.length); } catch { return []; }
}

function writeSessions() {
  fs.writeFileSync(SESSION_FILE, JSON.stringify([...sessions.values()].filter(s => s.tabs?.length), null, 1));
}

function createWindow(dir, session) {
  const win = new BrowserWindow({
    width: 1400, height: 860, ...session?.bounds, minWidth: 600, minHeight: 400,
    title: 'Agent Terminal', backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
    },
  });
  if (session?.maximized) win.maximize();
  const wcId = win.webContents.id;
  if (session) restoring.set(wcId, session);
  // Closing one of several windows forgets its tabs; closing the last window keeps them for next launch.
  win.on('closed', () => {
    if (BrowserWindow.getAllWindows().length) { sessions.delete(wcId); writeSessions(); }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: dir ? { dir } : {} });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  let confirmed = false;
  win.on('close', e => {
    const n = tabCounts.get(win) || 0;
    if (!confirmed && current.settings.confirmOnClose && n >= 2) {
      // The async dialog is the only one that reports the checkbox, so hold the close and redo it on "Close all".
      e.preventDefault();
      dialog.showMessageBox(win, {
        type: 'question', buttons: ['Close all', 'Cancel'], defaultId: 1, cancelId: 1,
        message: `Close ${n} tabs? Their shells and agents will be stopped${current.settings.restoreSession ? ' (the tabs reopen next time)' : ''}.`,
        checkboxLabel: "Don't ask me again",
      }).then(({ response, checkboxChecked }) => {
        if (response !== 0) return;
        if (checkboxChecked) {
          settings.update(SETTINGS_FILE, { confirmOnClose: false });
          current = settings.load(SETTINGS_FILE);
          broadcastSettings();
        }
        confirmed = true;
        win.close();
      });
      return;
    }
    const s = sessions.get(wcId);
    if (s) { Object.assign(s, { bounds: win.getNormalBounds(), maximized: win.isMaximized() }); writeSessions(); }
  });
  const wc = win.webContents;
  const killOwned = () => { for (const [id, p] of ptys) if (p.wc === wc) { p.proc.kill(); ptys.delete(id); } };
  wc.on('destroyed', killOwned);
  // A reload (e.g. from DevTools) starts a fresh page that no longer knows the old processes.
  wc.on('did-start-navigation', ({ isMainFrame, isSameDocument }) => { if (isMainFrame && !isSameDocument) killOwned(); });
}

function openExternal(url) {
  if (/^https?:\/\//i.test(url)) shell.openExternal(url);
}

const payload = () => ({ ...current, home: os.homedir() });

function broadcastSettings() {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', payload());
}

ipcMain.handle('settings:get', payload);
ipcMain.handle('session:get', e => restoring.get(e.sender.id) || null);
ipcMain.on('session:save', (e, s) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || !s || !Array.isArray(s.tabs)) return;
  sessions.set(e.sender.id, { ...s, bounds: win.getNormalBounds(), maximized: win.isMaximized() });
  writeSessions();
});
ipcMain.handle('settings:update', (_e, patch) => {
  settings.update(SETTINGS_FILE, patch);
  current = settings.load(SETTINGS_FILE);
  broadcastSettings();
});
ipcMain.handle('settings:openFile', async (_e, which) => {
  if (which === 'defaults') {
    fs.writeFileSync(DEFAULTS_FILE, JSON.stringify(current.settings, null, 2) + '\n');
    return shell.openPath(DEFAULTS_FILE);
  }
  if (!fs.existsSync(SETTINGS_FILE)) settings.update(SETTINGS_FILE, {});
  return shell.openPath(SETTINGS_FILE);
});
// Poll instead of fs.watch: editors replace files atomically, which breaks watch handles.
fs.watchFile(SETTINGS_FILE, { interval: 1000 }, () => {
  current = settings.load(SETTINGS_FILE);
  broadcastSettings();
});

// kind: 'shell' (name = profile), 'agent' (name = agent id), 'sbx' (the sbx TUI),
// 'sandbox' (args = sbx arguments, e.g. ['run', '--name', 'my-sandbox']).
async function launchSpec({ kind, name, args, resume }) {
  if (kind === 'shell') return settings.shellLaunch(current.settings, name);
  if (kind === 'agent') return settings.agentLaunch(current.settings, name, !!resume);
  if (kind !== 'sbx' && kind !== 'sandbox') return null;
  const file = await sbxPath();
  if (!file) throw new Error('sbx was not found on PATH. Install Docker Sandboxes: https://docs.docker.com/ai/sandboxes/');
  if (kind === 'sbx') return { file, args: [] };
  if (!Array.isArray(args) || !args.every(a => typeof a === 'string')) return null;
  return { file, args };
}

ipcMain.handle('pty:spawn', async (e, req) => {
  const { kind, name, cwd, cols, rows } = req;
  const spec = await launchSpec(req);
  if (!spec) throw new Error(`Unknown ${kind} "${name}". Check your settings.`);
  const dir = settings.resolveDir(cwd);
  let env = { ...process.env, COLORTERM: 'truecolor', TERM_PROGRAM: 'agent-terminal', ...spec.env };
  if (kind === 'sbx') {
    env = sandbox.shimEnv(env, await sandbox.ensureShim(SHIM_DIR));
    sbxOwner = e.sender;
  }
  const proc = pty.spawn(spec.file, spec.args, {
    name: 'xterm-256color', cols, rows, cwd: dir, env,
    useConptyDll: process.platform === 'win32', // bundled ConPTY: same rendering fixes as Windows Terminal
  });
  const id = nextPtyId++;
  const wc = e.sender;
  ptys.set(id, { proc, wc });
  proc.onData(d => { if (!wc.isDestroyed()) wc.send('pty:data', id, d); });
  proc.onExit(({ exitCode }) => {
    ptys.delete(id);
    if (!wc.isDestroyed()) wc.send('pty:exit', id, exitCode);
  });
  return { id, cwd: dir };
});
ipcMain.on('pty:write', (_e, id, data) => ptys.get(id)?.proc.write(data));
ipcMain.on('pty:resize', (_e, id, cols, rows) => {
  try { ptys.get(id)?.proc.resize(cols, rows); } catch { /* process already exited */ }
});
ipcMain.on('pty:kill', (_e, id) => { ptys.get(id)?.proc.kill(); ptys.delete(id); });

ipcMain.handle('info:get', (_e, req) => getInfo(req));
ipcMain.handle('sbx:list', async () => sandbox.list(await sbxPath()));
// What the setup wizard needs to know: which agent CLIs and sbx are installed.
ipcMain.handle('setup:detect', async () => {
  const agents = {};
  await Promise.all(current.settings.agents.map(async a => { agents[a.id] = !!await sandbox.which(a.command.split(/\s+/)[0]); }));
  return { agents, sbx: !!await sbxPath() };
});
ipcMain.handle('dialog:openFolder', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// Electron's clipboard API is promise-based, so these can't be synchronous IPC.
ipcMain.handle('clipboard:read', () => clipboard.readText());
ipcMain.on('clipboard:write', (_e, text) => { clipboard.writeText(String(text)).catch(() => {}); });
ipcMain.on('shell:openExternal', (_e, url) => openExternal(url));
ipcMain.on('shell:openPath', (_e, p) => shell.openPath(settings.resolveDir(p)));
ipcMain.on('tabs:count', (e, n) => tabCounts.set(BrowserWindow.fromWebContents(e.sender), n));
ipcMain.on('window:new', () => createWindow());
ipcMain.on('window:toggle', (e, what) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (what === 'fullscreen') w.setFullScreen(!w.isFullScreen());
  if (what === 'alwaysOnTop') w.setAlwaysOnTop(!w.isAlwaysOnTop());
  if (what === 'devtools') w.webContents.toggleDevTools();
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // keys like Ctrl+Shift+I belong to the terminal, not the default menu
  sandbox.listen(launch => {
    const wc = sbxOwner && !sbxOwner.isDestroyed() ? sbxOwner : BrowserWindow.getAllWindows()[0]?.webContents;
    wc?.send('sbx:open', launch);
  });
  const saved = current.settings.restoreSession ? readSessions() : [];
  if (!saved.length) createWindow(startupDir());
  saved.forEach((s, i) => createWindow(i === 0 ? startupDir() : null, s));
});
app.on('window-all-closed', () => app.quit());
