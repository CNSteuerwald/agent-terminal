'use strict';
/* global Terminal, FitAddon, SearchAddon, WebLinksAddon, Keys, api */

const $ = s => document.querySelector(s);
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(c => c != null && c !== false));
  return e;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let S = null;            // effective settings from main
let HOME = '';
let keymap = new Map();  // normalized combo -> action id
const tabs = [];
let active = null;
let tabSeq = 0;
let fontDelta = 0;
let renaming = false;
let started = false;     // first tab opened (after the setup wizard)
let sandboxWasEnabled = false;
const panes = new Map();   // pty id -> Pane
const pending = new Map(); // pty id -> events that arrived before spawn() resolved
const seenPtys = new Set();

// Tab types: 'workspace' (shell + agent CLI in one folder), 'sbx' (the Docker Sandboxes TUI, full window),
// 'sandbox' (a sandbox session opened from the sbx TUI + a host shell in its workspace).
// Each tab has two slots: tab.shell and tab.agent (the agent slot also holds sbx/sandbox panes).

// ---------------------------------------------------------------- actions
// [name, default keys, run]. run() returning false means "not handled": the key goes to the terminal.
const ACTIONS = {
  newTab: ['New tab (agent + terminal)', 'ctrl+shift+t', () => newTab()],
  newShellTab: ['New terminal tab (no agent)', 'ctrl+alt+t', () => newTab({ agent: '' })],
  openFolder: ['Open folder in new tab…', 'ctrl+shift+o', openFolderTab],
  duplicateTab: ['Duplicate tab', 'ctrl+shift+d', () => {
    if (active?.type === 'workspace') newTab({ cwd: active.cwd, profile: active.profile, agent: active.agentId || '' });
  }],
  closePane: ['Close pane (closes the tab when no panes are left)', 'ctrl+shift+w', () => active && closeSlot(active, active.focused)],
  closeTab: ['Close tab', '', () => active && closeTab(active)],
  nextTab: ['Next tab', 'ctrl+tab', () => cycleTab(1)],
  prevTab: ['Previous tab', 'ctrl+shift+tab', () => cycleTab(-1)],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map(n =>
    [`switchToTab${n}`, [`Switch to tab ${n}`, `ctrl+alt+${n}`, () => activate(tabs[n - 1])]])),
  switchToLastTab: ['Switch to last tab', 'ctrl+alt+9', () => activate(tabs.at(-1))],
  moveTabForward: ['Move tab forward', '', () => moveTab(1)],
  moveTabBackward: ['Move tab backward', '', () => moveTab(-1)],
  renameTab: ['Rename tab', '', () => active && startRename(active)],
  openTabColorPicker: ['Change tab color…', '', () => {
    const item = active && document.querySelectorAll('.tab')[tabs.indexOf(active)];
    if (item) showTabMenu(active, item);
  }],
  toggleSidebar: ['Toggle tab sidebar', 'ctrl+shift+s', () => api.updateSettings({ sidebarVisible: !S.sidebarVisible })],
  toggleTabLayout: ['Toggle vertical / horizontal tabs', '', () => api.updateSettings({ tabLayout: S.tabLayout === 'vertical' ? 'horizontal' : 'vertical' })],
  toggleAgentPane: ['Toggle agent pane', 'ctrl+shift+.', () => active && toggleAgentPane(active)],
  openShellPane: ['Open shell pane', '', () => active && openSlot(active, 'shell')],
  openAgentPane: ['Open agent pane', '', () => active && openSlot(active, 'agent')],
  focusAgentPane: ['Switch focus between shell and agent', 'ctrl+shift+i', () => active && focusPane(active, active.focused === 'agent' ? 'shell' : 'agent')],
  restartAgent: ['Restart agent', '', () => active?.agent?.restart()],
  restartShell: ['Restart shell', '', () => active?.shell?.restart()],
  toggleSplitOrientation: ['Toggle split orientation', '', () => {
    if (!active) return;
    active.position = { right: 'bottom', bottom: 'right', left: 'top', top: 'left' }[active.position];
    layoutTab(active);
  }],
  togglePaneZoom: ['Zoom focused pane', '', () => {
    if (!active?.shell || !active.agent) return;
    active.zoom = active.zoom ? null : active.focused;
    layoutTab(active);
  }],
  resizePaneLeft: ['Move split left', 'alt+shift+left', () => resizePane('left')],
  resizePaneRight: ['Move split right', 'alt+shift+right', () => resizePane('right')],
  resizePaneUp: ['Move split up', 'alt+shift+up', () => resizePane('up')],
  resizePaneDown: ['Move split down', 'alt+shift+down', () => resizePane('down')],
  copy: ['Copy', ['ctrl+shift+c', 'ctrl+c'], () => copySelection(focusedPane()) || false], // no selection: Ctrl+C still interrupts
  paste: ['Paste', ['ctrl+shift+v', 'ctrl+v'], () => {
    const p = focusedPane();
    if (!p) return false;
    api.readClipboard().then(text => {
      if (text) p.term.paste(text);
      else if (p.ptyId) api.write(p.ptyId, '\x16'); // no text (e.g. an image): send Ctrl+V so the CLI reads the clipboard itself
    }).catch(() => {});
  }],
  selectAll: ['Select all', 'ctrl+shift+a', () => focusedPane()?.term.selectAll()],
  find: ['Find', 'ctrl+shift+f', openFind],
  scrollUp: ['Scroll up', 'ctrl+shift+up', () => focusedPane()?.term.scrollLines(-1)],
  scrollDown: ['Scroll down', 'ctrl+shift+down', () => focusedPane()?.term.scrollLines(1)],
  scrollUpPage: ['Scroll up one page', 'ctrl+shift+pgup', () => focusedPane()?.term.scrollPages(-1)],
  scrollDownPage: ['Scroll down one page', 'ctrl+shift+pgdn', () => focusedPane()?.term.scrollPages(1)],
  scrollToTop: ['Scroll to top', 'ctrl+shift+home', () => focusedPane()?.term.scrollToTop()],
  scrollToBottom: ['Scroll to bottom', 'ctrl+shift+end', () => focusedPane()?.term.scrollToBottom()],
  clearBuffer: ['Clear buffer', 'ctrl+shift+k', () => focusedPane()?.term.clear()],
  increaseFontSize: ['Increase font size (also Ctrl+scroll)', 'ctrl+=', () => setFontDelta(fontDelta + 1)],
  decreaseFontSize: ['Decrease font size (also Ctrl+scroll)', 'ctrl+-', () => setFontDelta(fontDelta - 1)],
  resetFontSize: ['Reset font size', 'ctrl+0', () => setFontDelta(0)],
  commandPalette: ['Command palette', 'ctrl+shift+p', openPalette],
  openSbx: ['Open Docker Sandboxes (sbx) tab', '', () => ensureSbxTab({ activate: true })],
  openSettings: ['Open settings', 'ctrl+,', () => openSettings()],
  openSettingsFile: ['Open settings file (JSON)', 'ctrl+shift+,', () => api.openSettingsFile('user')],
  openDefaultSettingsFile: ['Open default settings (read-only)', 'ctrl+alt+,', () => api.openSettingsFile('defaults')],
  runSetup: ['Run setup wizard', '', () => runWizard()],
  openCwd: ['Open tab folder in file explorer', '', () => active && api.openPath(active.cwd)],
  newWindow: ['New window', 'ctrl+shift+n', () => api.newWindow()],
  toggleFullscreen: ['Toggle fullscreen', ['f11', 'alt+enter'], () => api.toggleWindow('fullscreen')],
  toggleAlwaysOnTop: ['Toggle always on top', '', () => api.toggleWindow('alwaysOnTop')],
  agentNewline: ['Agent pane: Shift+Enter inserts a newline', 'shift+enter', () => {
    const p = focusedPane();
    if (p?.slot !== 'agent' || p.kind === 'sbx' || !p.ptyId) return false;
    api.write(p.ptyId, '\x1b\r'); // Meta+Enter: newline in Claude Code and most agent TUIs
  }],
  toggleDevTools: ['Toggle developer tools', 'ctrl+shift+f12', () => api.toggleWindow('devtools')],
};

function bindingsFor(id) {
  const keys = id in S.keybindings ? S.keybindings[id] : ACTIONS[id][1];
  return [].concat(keys || []).filter(Boolean).map(Keys.normalize);
}

function buildKeymap() {
  keymap = new Map();
  for (const id of Object.keys(ACTIONS)) for (const k of bindingsFor(id)) keymap.set(k, id);
}

// Returns true when a bound action consumed the key.
function handleKey(e) {
  const id = keymap.get(Keys.eventToKey(e));
  return !!id && ACTIONS[id][2](e) !== false;
}

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && closeOverlays()) return e.preventDefault();
  if (!$('#wizard').hidden) return; // setup runs before any tab exists
  if (e.defaultPrevented || e.target.closest?.('.xterm, input, select, textarea')) return;
  if (handleKey(e)) e.preventDefault();
});
// Ctrl+scroll is handled per terminal (font size); never let it zoom the whole page.
window.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

// ---------------------------------------------------------------- color schemes
const withAlpha = (hex, a) => /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex;

function scheme(name) {
  return S.schemes.find(s => s.name === name) || S.schemes.find(s => s.name === S.colorScheme) || S.schemes[0];
}

function xtermTheme(name) {
  const s = scheme(name);
  return {
    foreground: s.foreground, background: s.background,
    cursor: s.cursorColor || s.foreground, cursorAccent: s.background,
    // Scheme selection colors are opaque; xterm draws selection over text, so make it translucent.
    selectionBackground: withAlpha(s.selectionBackground || s.foreground, 0.35),
    black: s.black, red: s.red, green: s.green, yellow: s.yellow, blue: s.blue, magenta: s.purple, cyan: s.cyan, white: s.white,
    brightBlack: s.brightBlack, brightRed: s.brightRed, brightGreen: s.brightGreen, brightYellow: s.brightYellow,
    brightBlue: s.brightBlue, brightMagenta: s.brightPurple, brightCyan: s.brightCyan, brightWhite: s.brightWhite,
  };
}

// ---------------------------------------------------------------- panes
const agentDef = id => S.agents.find(a => a.id === id);

// Display name of what a slot holds (or would hold if opened).
function slotName(tab, slot) {
  if (slot === 'shell') return tab.profile;
  if (tab.type === 'sbx') return 'Docker Sandboxes';
  if (tab.type === 'sandbox') return `Sandbox: ${tab.sandbox.name}`;
  return agentDef(tab.agentId || S.defaultAgent)?.name || 'Agent';
}

class Pane {
  constructor(tab, kind) {
    this.tab = tab;
    this.kind = kind; // 'shell' | 'agent' | 'sbx' | 'sandbox'
    this.slot = kind === 'shell' ? 'shell' : 'agent';
    this.ptyId = null;
    this.exited = false;
    this.schemeOverride = null;
    this.resume = false;  // next start resumes the agent's last conversation (restored tabs)
    this.lastInput = 0;   // output right after input/resize/focus is an echo or redraw, not agent work
    this.label = el('div', { className: 'pane-label' });
    this.host = el('div', { className: 'term' });
    this.el = el('div', { className: `pane pane-${this.slot}` }, this.label, this.host);
  }

  def() {
    if (this.kind === 'shell') return S.profiles.find(p => p.name === this.tab.profile);
    if (this.kind === 'agent') return agentDef(this.tab.agentId);
    if (this.kind === 'sandbox') return agentDef(this.tab.sandbox.agent);
    return null;
  }

  schemeName() { return this.schemeOverride || this.def()?.colorScheme || S.colorScheme; }

  options() {
    return {
      fontFamily: S.fontFace, fontSize: clamp(S.fontSize + fontDelta, 6, 72),
      cursorStyle: S.cursorShape, cursorBlink: S.cursorBlink, scrollback: S.historySize,
      theme: xtermTheme(this.schemeName()),
    };
  }

  open() {
    const t = this.term = new Terminal({ ...this.options(), allowProposedApi: true });
    this.fit = new FitAddon.FitAddon();
    this.search = new SearchAddon.SearchAddon();
    t.loadAddon(this.fit);
    t.loadAddon(this.search);
    t.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => api.openExternal(uri)));
    t.open(this.host);
    t.attachCustomKeyEventHandler(e => {
      if (e.type !== 'keydown' || !handleKey(e)) return true;
      e.preventDefault(); // also suppresses the keypress that would follow
      return false;
    });
    t.onData(d => {
      this.lastInput = Date.now();
      // Escape sequences here are mostly the terminal's automatic replies (cursor/color queries,
      // focus reports), not typing. Typing a prompt always includes printable keys or Enter.
      if (!d.startsWith('\x1b')) this.armed = true;
      if (this.exited) { if (d === '\r') this.start(); return; }
      if (this.ptyId) api.write(this.ptyId, d);
    });
    t.onResize(({ cols, rows }) => {
      this.lastInput = Date.now();
      if (this.ptyId) api.resize(this.ptyId, cols, rows);
    });
    t.onSelectionChange(() => { if (S.copyOnSelect && t.hasSelection()) api.writeClipboard(t.getSelection()); });
    t.onBell(() => { if (this.tab !== active) { this.tab.attention = true; renderTabs(); } });
    t.onTitleChange(title => { this.title = title; this.updateLabel(); });
    t.textarea.addEventListener('focus', () => { this.lastInput = Date.now(); this.tab.focused = this.slot; markFocused(this.tab); });
    if (this.kind === 'shell') {
      // The shell reports its folder at each prompt (see shell integration in settings.js).
      t.parser.registerOscHandler(9, data => {
        const m = data.match(/^9;"?([^"]*)"?$/);
        if (m) setTabCwd(this.tab, m[1]);
        return !!m; // other OSC 9 messages (notifications) are not ours
      });
      t.parser.registerOscHandler(7, data => {
        try { setTabCwd(this.tab, decodeURIComponent(new URL(data).pathname)); } catch { /* not a file URL */ }
        return true;
      });
    }
    // Right-click, like Windows Terminal: copy the selection if there is one, otherwise paste.
    this.host.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!copySelection(this)) { this.tab.focused = this.slot; ACTIONS.paste[2](); }
    });
    // OSC 52: lets CLIs (Claude Code, tmux, vim…) put text on the clipboard. Reading it ('?') stays blocked.
    t.parser.registerOscHandler(52, data => {
      const b64 = data.slice(data.indexOf(';') + 1);
      if (b64 && b64 !== '?') {
        try {
          const text = new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
          api.writeClipboard(text);
          notify(`Copied ${text.length} characters`);
        } catch { /* not valid base64 */ }
      }
      return true;
    });
    this.setupDragSelect();
    // Capture phase: runs before xterm's own wheel handler would scroll.
    this.host.addEventListener('wheel', e => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      setFontDelta(fontDelta + (e.deltaY < 0 ? 1 : -1));
    }, { capture: true, passive: false });
    new ResizeObserver(() => this.refit()).observe(this.host);
    this.updateLabel();
  }

  // In apps that capture the mouse (Claude Code, the sbx dashboard), a left-drag selects text as in a
  // plain shell, while a click without dragging still goes to the app. xterm only selects in that mode
  // on Shift+drag, so once the mouse moves the press is replayed with Shift held.
  setupDragSelect() {
    const replay = (ev, type, shiftKey) => ev.target.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, view: window, detail: ev.detail, button: 0, buttons: type === 'mouseup' ? 0 : 1,
      clientX: ev.clientX, clientY: ev.clientY, screenX: ev.screenX, screenY: ev.screenY,
      ctrlKey: ev.ctrlKey, altKey: ev.altKey, metaKey: ev.metaKey, shiftKey,
    }));
    // xterm clears the selection whenever it sends the app input, and in mouse-capture mode plain mouse
    // movement and the right-button press are sent as input. While text is selected, keep those from
    // the app so the selection survives to be copied (right-click then copies it).
    const keepsSelection = ev => this.term.modes.mouseTrackingMode !== 'none' && this.term.hasSelection();
    this.host.addEventListener('mousemove', ev => { if (ev.buttons === 0 && keepsSelection()) ev.stopPropagation(); }, true);
    this.host.addEventListener('mousedown', ev => { if (ev.button === 2 && keepsSelection()) ev.stopPropagation(); }, true);
    this.host.addEventListener('mousedown', down => {
      if (!S.dragToSelect || !down.isTrusted || down.button !== 0 || down.shiftKey || this.term.modes.mouseTrackingMode === 'none') return;
      down.stopPropagation();
      down.preventDefault();
      this.term.focus();
      let dragging = false;
      const move = ev => {
        if (dragging || Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 4) return;
        dragging = true;
        this.term.clearSelection(); // Shift+press would otherwise extend an old selection
        replay(down, 'mousedown', true);
      };
      const up = ev => {
        document.removeEventListener('mousemove', move, true);
        document.removeEventListener('mouseup', up, true);
        if (dragging) return; // xterm finishes the selection with this real mouseup
        ev.stopPropagation();
        replay(down, 'mousedown', false); // just a click: hand it to the app unchanged
        replay(ev, 'mouseup', false);
      };
      document.addEventListener('mousemove', move, true);
      document.addEventListener('mouseup', up, true);
    }, true);
  }

  // Header bar: name, "+ open the other pane" when it's closed, and a close button.
  updateLabel() {
    const tab = this.tab;
    const name = slotName(tab, this.slot);
    const other = this.slot === 'shell' ? 'agent' : 'shell';
    const otherMissing = other === 'agent' ? !(tab.agent && tab.agentVisible) : !tab.shell;
    const title = el('span', { className: 'pane-title', textContent: this.title && this.title !== name ? `${name} — ${this.title}` : name });
    const open = otherMissing && tab.type !== 'sbx' && el('button', {
      className: 'pane-open', textContent: `+ ${slotName(tab, other)}`, title: `Open ${slotName(tab, other)}`,
    });
    if (open) open.onclick = () => openSlot(tab, other);
    const close = el('button', { className: 'pane-close', textContent: '×', title: `Close ${name}`, ariaLabel: `Close ${name}` });
    close.onclick = () => closeSlot(tab, this.slot);
    this.label.replaceChildren(...[title, el('span', { className: 'spacer' }), open, close].filter(Boolean));
  }

  applySettings() {
    if (!this.term) return;
    Object.assign(this.term.options, this.options());
    this.updateLabel();
    this.refit();
  }

  refit() {
    if (!this.term || !this.host.offsetWidth || !this.host.offsetHeight) return;
    try { this.fit.fit(); } catch { /* not rendered yet */ }
  }

  spawnRequest() {
    const tab = this.tab;
    const base = { kind: this.kind, cwd: tab.cwd, cols: this.term.cols, rows: this.term.rows };
    if (this.kind === 'shell') return { ...base, name: tab.profile };
    // A resumed agent must start where its conversation was, even if the shell has moved on.
    if (this.kind === 'agent') return { ...base, name: tab.agentId, resume: this.resume, cwd: (this.resume && tab.agentCwd) || tab.cwd };
    if (this.kind === 'sandbox') return { ...base, name: tab.sandbox.name, args: tab.sandbox.args };
    return base; // sbx
  }

  async start() {
    this.exited = false;
    this.term.reset();
    this.refit();
    try {
      const { id, cwd } = await api.spawn(this.spawnRequest());
      if (this.disposed) return api.kill(id);
      if (this.slot === 'shell' || !this.tab.shell) this.tab.cwd = cwd;
      if (this.kind === 'agent') { this.tab.agentStarted = Date.now(); this.tab.agentCwd = cwd; }
      this.resume = false;
      // Agents only work after you give them something: startup banners and resumed history don't count.
      this.armed = false;
      this.ptyId = id;
      panes.set(id, this);
      seenPtys.add(id);
      const buffered = pending.get(id) || [];
      pending.delete(id);
      for (const ev of buffered) deliver(this, ev);
    } catch (err) {
      this.term.write(`\x1b[31m${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
      this.markExited();
    }
  }

  markExited(code) {
    panes.delete(this.ptyId);
    this.ptyId = null;
    this.exited = true;
    this.term.write(`\r\n\x1b[90m[process exited${code != null ? ` with code ${code}` : ''}. Press Enter to restart]\x1b[0m\r\n`);
  }

  kill() {
    if (!this.ptyId) return;
    api.kill(this.ptyId);
    panes.delete(this.ptyId);
    this.ptyId = null;
  }

  restart() { this.kill(); this.start(); }

  dispose() { this.disposed = true; this.kill(); this.term?.dispose(); this.el.remove(); }
}

function deliver(p, ev) {
  if ('exit' in ev) return p.markExited(ev.exit);
  p.term.write(ev.data);
  const now = Date.now();
  if (p.slot === 'agent' && p.armed && now - p.lastInput > 500) {
    p.tab.lastAgentOutput = now;
    p.tab.busySince ||= now;
  }
}

// Called from the shell's cwd reports. Only accepts real host paths (not e.g. WSL's /home/...).
function setTabCwd(tab, dir) {
  if (api.platform === 'win32') {
    dir = dir.replace(/^\/([a-zA-Z]):?\//, '$1:/').replace(/\//g, '\\'); // file:///C:/x and Git Bash /c/x
    if (!/^[a-zA-Z]:\\/.test(dir)) return;
  } else if (!dir.startsWith('/')) return;
  if (dir === tab.cwd) return;
  tab.cwd = dir;
  renderTabs();
  refreshInfo([tab]);
}
// Output can arrive before spawn() resolves; buffer it. Ids already seen belong to killed panes.
function onPtyEvent(id, ev) {
  const p = panes.get(id);
  if (p) deliver(p, ev);
  else if (!seenPtys.has(id)) pending.set(id, [...(pending.get(id) || []), ev]);
}
api.onData((id, data) => onPtyEvent(id, { data }));
api.onExit((id, code) => onPtyEvent(id, { exit: code }));

// Copies a pane's selection. Returns false when there is nothing selected.
function copySelection(p) {
  const t = p?.term;
  if (!t?.hasSelection()) return false;
  const text = t.getSelection();
  api.writeClipboard(text);
  t.clearSelection();
  notify(`Copied ${text.length} characters`);
  return true;
}

const tabPanes = tab => [tab.shell, tab.agent].filter(Boolean);
const primaryPane = tab => tab.shell || tab.agent;

// ---------------------------------------------------------------- tabs
async function createTab(o) {
  const tab = {
    id: ++tabSeq, type: o.type, color: o.color || null, cwd: o.cwd ?? S.startingDirectory, profile: o.profile || S.defaultProfile,
    agentId: o.agentId || null, agentCwd: o.agentCwd || null, sandbox: o.sandbox || null, title: o.title || null,
    position: o.position || S.agentPanePosition, size: o.size || S.agentPaneSize, zoom: null,
    agentVisible: o.agentVisible ?? true, focused: 'agent', shell: null, agent: null,
    info: {}, attention: false, done: false, lastAgentOutput: 0, busySince: 0, agentStarted: 0,
  };
  tab.view = el('div', { className: 'view' });
  tab.divider = el('div', { className: 'divider', role: 'separator', ariaLabel: 'Resize split' });
  tab.view.append(tab.divider);
  setupDivider(tab);
  if (o.atStart) tabs.unshift(tab);
  else tabs.push(tab);
  $('#views').append(tab.view);
  if (o.shell !== false) addPane(tab, 'shell');
  const agentKind = { workspace: tab.agentId && 'agent', sbx: 'sbx', sandbox: 'sandbox' }[tab.type];
  if (agentKind && o.agent !== false) addPane(tab, agentKind).resume = !!o.resume;
  if (!tab.agent) { tab.focused = 'shell'; tab.agentVisible = true; }
  tab.view.classList.add('active'); // xterm must measure its cell size while visible...
  for (const p of tabPanes(tab)) p.open(); // ...so open before layout can hide a pane
  layoutTab(tab);
  tab.view.classList.add('active');
  const starting = tabPanes(tab).map(p => p.start()); // start() fits synchronously before awaiting
  if (o.activate === false) { tab.view.classList.remove('active'); renderTabs(); } else activate(tab);
  await Promise.all(starting);
  renderTabs();
  refreshInfo([tab]);
  return tab;
}

function newTab({ cwd, profile, agent = S.defaultAgent } = {}) {
  return createTab({ type: 'workspace', cwd, profile, agentId: agent });
}

function addPane(tab, kind) {
  const p = new Pane(tab, kind);
  tab[p.slot] = p;
  if (p.slot === 'shell') tab.view.prepend(p.el);
  else tab.view.append(p.el);
  return p;
}

async function openFolderTab() {
  const dir = await api.openFolder();
  if (dir) newTab({ cwd: dir });
}

function ensureSbxTab({ activate: show }) {
  const existing = tabs.find(t => t.type === 'sbx');
  if (existing) return show && activate(existing);
  createTab({ type: 'sbx', title: 'sbx', shell: false, atStart: true, activate: show });
}

// Called when the sbx TUI opens a sandbox in an "external terminal".
async function openSandboxTab({ args, name }) {
  const open = tabs.find(t => t.type === 'sandbox' && t.sandbox.name === name && t.agent?.ptyId);
  if (open) return activate(open);
  const sb = (await api.sbxList()).find(s => s.name === name);
  const workspace = sb?.workspaces?.[0];
  createTab({
    type: 'sandbox', title: name || 'sandbox', sandbox: { name, args, agent: sb?.agent },
    cwd: workspace, shell: !!workspace,
  });
}

function closeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  for (const p of tabPanes(tab)) p.dispose();
  tab.view.remove();
  tabs.splice(i, 1);
  if (!tabs.length) { saveSession(); return window.close(); }
  if (tab === active) activate(tabs[Math.min(i, tabs.length - 1)]);
  else renderTabs();
}

// Closing a pane works like closing a tab; when both panes are gone the tab closes.
function closeSlot(tab, slot) {
  const pane = tab[slot];
  if (!pane) return;
  pane.dispose();
  tab[slot] = null;
  if (!tab.shell && !tab.agent) return closeTab(tab);
  if (!tab.shell) tab.agentVisible = true; // never leave a tab with only a hidden pane
  tab.zoom = null;
  layoutTab(tab);
  focusPane(tab, slot === 'shell' ? 'agent' : 'shell');
  renderTabs();
}

function openSlot(tab, slot) {
  if (tab.type === 'sbx') return;
  if (slot === 'agent' && tab.agent) {
    tab.agentVisible = true;
  } else if (!tab[slot]) {
    if (slot === 'agent' && tab.type === 'workspace') {
      tab.agentId = tab.agentId || S.defaultAgent || S.agents[0]?.id;
      if (!tab.agentId) return;
    }
    const p = addPane(tab, slot === 'shell' ? 'shell' : tab.type === 'sandbox' ? 'sandbox' : 'agent');
    if (slot === 'agent') tab.agentVisible = true;
    layoutTab(tab);
    p.open();
    p.start();
  }
  layoutTab(tab);
  focusPane(tab, slot);
  renderTabs();
}

function activate(tab) {
  if (!tab) return;
  active = tab;
  tab.attention = false;
  tab.done = false;
  for (const t of tabs) t.view.classList.toggle('active', t === tab);
  document.documentElement.style.setProperty('--term-bg', scheme(primaryPane(tab).schemeName()).background);
  renderTabs();
  requestAnimationFrame(() => {
    for (const p of tabPanes(tab)) p.refit();
    focusPane(tab, tab.focused);
  });
}

function cycleTab(dir) {
  if (tabs.length) activate(tabs[(tabs.indexOf(active) + dir + tabs.length) % tabs.length]);
}

// The sbx tab stays pinned first.
const pinSbxFirst = () => tabs.sort((a, b) => (b.type === 'sbx') - (a.type === 'sbx'));

function moveTab(dir) {
  const i = tabs.indexOf(active), j = i + dir;
  if (!active || j < 0 || j >= tabs.length) return;
  [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
  pinSbxFirst();
  renderTabs();
}

function focusedPane(tab = active) {
  if (!tab) return null;
  const agentShown = tab.agent && tab.agentVisible;
  return (tab.focused === 'agent' && agentShown) || !tab.shell ? tab.agent : tab.shell;
}

function focusPane(tab, slot) {
  if (slot === 'agent' && !(tab.agent && tab.agentVisible)) slot = 'shell';
  if (slot === 'shell' && !tab.shell) slot = 'agent';
  if (tab.zoom && tab.zoom !== slot) { tab.zoom = slot; layoutTab(tab); }
  tab.focused = slot;
  focusedPane(tab)?.term?.focus();
  markFocused(tab);
}

function markFocused(tab) {
  tab.shell?.el.classList.toggle('focused', tab.focused === 'shell');
  tab.agent?.el.classList.toggle('focused', tab.focused === 'agent');
}

function toggleAgentPane(tab) {
  if (tab.type === 'sbx') return;
  if (!tab.agent || !tab.agentVisible) return openSlot(tab, 'agent');
  if (!tab.shell) return; // hiding the only pane would leave an empty tab
  tab.agentVisible = false;
  if (tab.zoom === 'agent') tab.zoom = null;
  layoutTab(tab);
  focusPane(tab, 'shell');
  renderTabs();
}

function switchAgent(id) {
  const tab = active;
  if (tab?.type !== 'workspace') return;
  tab.agentId = id;
  tab.info.model = null;
  if (!tab.agent) return openSlot(tab, 'agent');
  tab.agent.title = null;
  tab.agent.applySettings();
  tab.agent.restart();
  openSlot(tab, 'agent');
}

function layoutTab(tab) {
  const showShell = !!tab.shell;
  const showAgent = !!tab.agent && tab.agentVisible;
  const both = showShell && showAgent;
  tab.view.className = ['view', `pos-${tab.position}`, `type-${tab.type}`, tab === active && 'active', both && tab.zoom && `zoom-${tab.zoom}`]
    .filter(Boolean).join(' ');
  tab.divider.hidden = !both;
  if (tab.agent) {
    tab.agent.el.hidden = !showAgent;
    tab.agent.el.style.flex = both ? `0 0 ${tab.size}%` : '1 1 0';
  }
  for (const p of tabPanes(tab)) if (p.term) p.updateLabel();
  scheduleSave();
}

// ---------------------------------------------------------------- session (reopen tabs on launch)
// The sbx tab isn't saved: it comes back from the sandboxEnabled setting.
function sessionState() {
  const saved = tabs.filter(t => t.type !== 'sbx');
  return {
    active: active?.type === 'sbx' ? 'sbx' : saved.indexOf(active),
    tabs: saved.map(t => ({
      type: t.type, cwd: t.cwd, agentCwd: t.agentCwd, profile: t.profile, agentId: t.agentId, sandbox: t.sandbox,
      title: t.title, color: t.color, position: t.position, size: t.size, agentVisible: t.agentVisible, shell: !!t.shell, agent: !!t.agent,
    })),
  };
}

let saveTimer;
function saveSession() {
  clearTimeout(saveTimer);
  if (started) api.saveSession(sessionState());
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSession, 500);
}
window.addEventListener('beforeunload', saveSession);

async function restoreSession(s) {
  const created = s.tabs.map(st => createTab({ ...st, resume: true, activate: false }));
  if (S.sandboxEnabled) ensureSbxTab({ activate: s.active === 'sbx' });
  const target = await created[s.active];
  activate(target || tabs.find(t => t.type !== 'sbx') || tabs[0]);
  await Promise.all(created);
}

function setupDivider(tab) {
  const d = tab.divider;
  d.addEventListener('pointerdown', e => {
    d.setPointerCapture(e.pointerId);
    const move = ev => {
      const r = tab.view.getBoundingClientRect();
      const frac = {
        right: (r.right - ev.clientX) / r.width, left: (ev.clientX - r.left) / r.width,
        bottom: (r.bottom - ev.clientY) / r.height, top: (ev.clientY - r.top) / r.height,
      }[tab.position];
      tab.size = clamp(frac * 100, 10, 90);
      layoutTab(tab);
    };
    const up = () => { d.removeEventListener('pointermove', move); d.removeEventListener('pointerup', up); };
    d.addEventListener('pointermove', move);
    d.addEventListener('pointerup', up);
  });
}

function resizePane(dir) {
  const t = active;
  if (!t?.shell || !t.agent || !t.agentVisible) return;
  // Moving the split toward the agent's side shrinks the agent pane.
  const sign = { right: { left: 1, right: -1 }, left: { left: -1, right: 1 }, bottom: { up: 1, down: -1 }, top: { up: -1, down: 1 } }[t.position][dir];
  if (!sign) return;
  t.size = clamp(t.size + 5 * sign, 10, 90);
  layoutTab(t);
}

function setFontDelta(d) {
  fontDelta = clamp(d, 6 - S.fontSize, 72 - S.fontSize);
  for (const t of tabs) for (const p of tabPanes(t)) p.applySettings();
}

function setPaneScheme(name) {
  const p = focusedPane();
  if (!p) return;
  p.schemeOverride = name;
  p.applySettings();
  if (p === primaryPane(active)) document.documentElement.style.setProperty('--term-bg', scheme(name).background);
}

// ---------------------------------------------------------------- tab list
const basename = p => p.split(/[\\/]/).filter(Boolean).pop() || p;
const tabTitle = t => t.title || basename(t.cwd);
const shortPath = p => (HOME && p.toLowerCase().startsWith(HOME.toLowerCase()) ? '~' + p.slice(HOME.length) : p);
// The sbx dashboard redraws constantly, so it never counts as agent activity.
const isWorking = t => S.tabMetadata.activity && t.type !== 'sbx' && Date.now() - t.lastAgentOutput < 2000;

function gitLine(g) {
  const parts = [el('span', { textContent: g.branch })];
  if (g.ahead) parts.push(` ↑${g.ahead}`);
  if (g.behind) parts.push(` ↓${g.behind}`);
  parts.push(g.changes
    ? el('span', { className: 'dirty', textContent: ` ● ${g.changes} changed` })
    : el('span', { className: 'clean', textContent: ' ✓' }));
  return el('div', { className: 'meta git', title: 'Git branch and status' }, ...parts);
}

function tabMetas(tab) {
  const m = S.tabMetadata;
  if (tab.type === 'sbx') {
    const list = tab.info.sandboxes;
    return [el('div', {
      className: 'meta', textContent: list ? `Docker Sandboxes · ${list.filter(s => s.status === 'running').length} running / ${list.length}` : 'Docker Sandboxes',
    })];
  }
  const agentLine = tab.type === 'sandbox'
    ? `⧉ sandbox · ${[tab.sandbox.agent, tab.info.status].filter(Boolean).join(' · ')}`
    : tab.agentId && `✦ ${[tab.info.model, agentDef(tab.agentId)?.name].filter(Boolean).join(' · ')}`;
  const hidden = tab.agent && !tab.agentVisible ? ' (hidden)' : !tab.agent ? ' (closed)' : '';
  return [
    m.directory && el('div', { className: 'meta dir', textContent: shortPath(tab.cwd), title: tab.cwd }),
    m.git && tab.info.git?.branch && gitLine(tab.info.git),
    m.model && agentLine && el('div', { className: 'meta model', title: 'Agent and model', textContent: agentLine + hidden }),
  ];
}

function tabItem(tab) {
  const isSbx = tab.type === 'sbx';
  const item = el('div', {
    className: ['tab', `tab-${tab.type}`, tab === active && 'active', tab.attention && 'attention'].filter(Boolean).join(' '),
    role: 'tab', tabIndex: 0, draggable: !isSbx, title: isSbx ? 'Docker Sandboxes (sbx)' : tab.cwd,
  });
  item.setAttribute('aria-selected', String(tab === active));
  const close = el('button', { className: 'tab-close', textContent: '×', title: 'Close tab', ariaLabel: `Close ${tabTitle(tab)}` });
  close.onclick = e => { e.stopPropagation(); closeTab(tab); };
  const title = el('span', { className: 'tab-title', textContent: tabTitle(tab) });
  title.ondblclick = () => startRename(tab, title);
  const state = isWorking(tab) ? ['working', 'Agent is working']
    : tab.attention ? ['attention', 'Needs attention']
      : tab.done ? ['done', 'Agent finished']
        : ['', 'Agent idle'];
  const marker = isSbx
    ? el('span', { className: 'sbx-icon', textContent: '⬢', ariaHidden: 'true' })
    : el('span', { className: `dot ${state[0]}`, title: state[1] });
  item.append(el('div', { className: 'tab-head' }, marker, title, close), el('div', { className: 'metas' }, ...tabMetas(tab)));
  item.onclick = () => activate(tab);
  item.onauxclick = e => { if (e.button === 1) closeTab(tab); };
  item.oncontextmenu = e => {
    e.preventDefault();
    showTabMenu(tab, { left: e.clientX, top: e.clientY, bottom: e.clientY });
  };
  if (tab.color) {
    item.classList.add('colored');
    item.style.setProperty('--tab-color', tab.color);
  }
  item.onkeydown = e => { if (e.key === 'Enter') activate(tab); };
  item.ondragstart = e => { e.dataTransfer.setData('text/x-tab', String(tab.id)); };
  item.ondragover = e => { e.preventDefault(); item.classList.add('drop-target'); };
  item.ondragleave = () => item.classList.remove('drop-target');
  item.ondrop = e => {
    e.preventDefault();
    const from = tabs.findIndex(t => String(t.id) === e.dataTransfer.getData('text/x-tab'));
    if (from < 0) return;
    const [moved] = tabs.splice(from, 1);
    tabs.splice(tabs.indexOf(tab) + (from <= tabs.indexOf(tab) ? 1 : 0), 0, moved);
    pinSbxFirst();
    renderTabs();
  };
  return item;
}

function renderTabs() {
  if (renaming || !S) return;
  $('#tabs').replaceChildren(...tabs.map(tabItem));
  api.setTabCount(tabs.length);
  scheduleSave();
  document.title = active ? `${tabTitle(active)} - Agent Terminal` : 'Agent Terminal';
}

function startRename(tab, titleEl) {
  titleEl ??= [...document.querySelectorAll('.tab')][tabs.indexOf(tab)]?.querySelector('.tab-title');
  if (!titleEl) return;
  renaming = true;
  const input = el('input', { className: 'tab-title-input', value: tabTitle(tab), ariaLabel: 'Tab name' });
  const done = save => {
    if (!renaming) return;
    renaming = false;
    if (save) tab.title = input.value.trim() || null;
    renderTabs();
    focusPane(active, active.focused);
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
  input.onclick = e => e.stopPropagation();
  titleEl.replaceWith(input);
  input.select();
  input.focus();
}

// Activity dots change without any event, so re-render when they flip. When a stretch of work
// (at least a few seconds of output) ends on a tab you're not looking at, mark it done (green).
let lastWorking = '';
setInterval(() => {
  for (const t of tabs) {
    if (!t.busySince || isWorking(t)) continue;
    if (t !== active && t.lastAgentOutput - t.busySince > 3000) t.done = true;
    t.busySince = 0;
  }
  const w = tabs.map(t => `${isWorking(t)}${t.done}`).join();
  if (w !== lastWorking) { lastWorking = w; renderTabs(); }
}, 500);

async function refreshInfo(list = tabs) {
  if (!S) return;
  const sandboxes = list.some(t => t.type !== 'workspace') ? await api.sbxList().catch(() => null) : null;
  await Promise.all(list.map(async t => {
    if (t.type === 'sbx') { t.info.sandboxes = sandboxes; return; }
    if (t.type === 'sandbox') t.info.status = sandboxes?.find(s => s.name === t.sandbox.name)?.status;
    if (!(S.tabMetadata.git || S.tabMetadata.model)) return;
    try {
      const agentId = t.type === 'workspace' ? t.agentId : null;
      const { git, model } = await api.getInfo({
        cwd: t.cwd, agentCwd: t.agentCwd, agentId, command: agentDef(agentId)?.command, since: t.agentStarted,
      });
      Object.assign(t.info, { git, model });
    } catch { /* keep the last known info */ }
  }));
  renderTabs();
}
setInterval(refreshInfo, 5000);

// ---------------------------------------------------------------- new-tab menu
// ---------------------------------------------------------------- tab context menu (color, rename, close)
const TAB_COLORS = ['#E74856', '#F7630C', '#FFB900', '#16C60C', '#00B7C3', '#0078D4', '#8764B8', '#E3008C', '#7A7574'];

function setTabColor(tab, color) {
  tab.color = color || null;
  renderTabs();
}

function showTabMenu(tab, at) {
  const isSbx = tab.type === 'sbx';
  const swatches = el('div', { className: 'menu-swatches', role: 'group', ariaLabel: 'Tab color' },
    ...TAB_COLORS.map(c => {
      const b = el('button', { className: 'swatch' + (tab.color === c ? ' selected' : ''), title: c, ariaLabel: `Color ${c}` });
      b.style.background = c;
      b.onclick = () => { $('#menu').hidden = true; setTabColor(tab, c); };
      return b;
    }));
  const custom = el('label', { className: 'menu-custom' }, 'Custom color…',
    el('input', { type: 'color', value: tab.color || TAB_COLORS[5], ariaLabel: 'Custom tab color' }));
  custom.querySelector('input').oninput = e => setTabColor(tab, e.target.value);
  showMenu(at, [
    !isSbx && 'Tab color', !isSbx && swatches, !isSbx && custom,
    !isSbx && tab.color && { label: 'Reset color', run: () => setTabColor(tab, null) },
    !isSbx && '-',
    { label: 'Rename tab', run: () => startRename(tab) },
    { label: 'Close tab', run: () => closeTab(tab) },
  ]);
}

// anchor: an element, or a point { left, top, bottom } (e.g. the mouse position for a context menu).
// items: '-' separator, 'Header' text, { label, run }, or a ready-made element.
function showMenu(anchor, items) {
  const menu = $('#menu');
  menu.replaceChildren(...items.filter(Boolean).map(it => {
    if (it instanceof Node) return it;
    if (it === '-') return el('hr');
    if (typeof it === 'string') return el('div', { className: 'menu-header', textContent: it });
    const b = el('button', { textContent: it.label, role: 'menuitem' });
    b.onclick = () => { menu.hidden = true; it.run(); };
    return b;
  }));
  menu.hidden = false;
  const r = anchor.getBoundingClientRect?.() ?? anchor;
  menu.style.left = `${Math.min(r.left, innerWidth - menu.offsetWidth - 8)}px`;
  menu.style.top = r.bottom + menu.offsetHeight < innerHeight ? `${r.bottom + 4}px` : `${r.top - menu.offsetHeight - 4}px`;
  menu.querySelector('button')?.focus();
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu, #new-tab-menu')) $('#menu').hidden = true; });

$('#new-agent-tab').onclick = () => newTab();
$('#new-shell-tab').onclick = () => newTab({ agent: '' });
$('#settings-btn').onclick = () => openSettings();
$('#new-tab-menu').onclick = e => showMenu(e.currentTarget, [
  'Shell',
  ...S.profiles.map(p => ({ label: p.name + (p.name === S.defaultProfile ? ' (default)' : ''), run: () => newTab({ profile: p.name }) })),
  '-', 'Agent',
  ...S.agents.map(a => ({ label: a.name + (a.id === S.defaultAgent ? ' (default)' : ''), run: () => newTab({ agent: a.id }) })),
  { label: 'No agent', run: () => newTab({ agent: '' }) },
  '-',
  { label: 'Open folder…', run: openFolderTab },
  S.sandboxEnabled && { label: 'Docker Sandboxes (sbx)', run: () => ensureSbxTab({ activate: true }) },
  { label: 'Settings', run: () => openSettings() },
]);

// Sidebar width drag (vertical layout only).
$('#sidebar-resizer').addEventListener('pointerdown', e => {
  const r = e.currentTarget;
  r.setPointerCapture(e.pointerId);
  let width = S.sidebarWidth;
  const move = ev => {
    width = clamp(Math.round(ev.clientX), 140, 600);
    document.documentElement.style.setProperty('--sidebar-w', `${width}px`);
  };
  const up = () => {
    r.removeEventListener('pointermove', move);
    r.removeEventListener('pointerup', up);
    api.updateSettings({ sidebarWidth: width });
  };
  r.addEventListener('pointermove', move);
  r.addEventListener('pointerup', up);
});

// ---------------------------------------------------------------- find
let findPane = null;
function openFind() {
  findPane = focusedPane();
  if (!findPane) return;
  $('#findbar').hidden = false;
  $('#find-input').select();
  $('#find-input').focus();
}
function find(dir) {
  const q = $('#find-input').value;
  if (!q || !findPane) return;
  if (dir < 0) findPane.search.findPrevious(q);
  else findPane.search.findNext(q);
}
function closeFind() {
  if ($('#findbar').hidden) return false;
  $('#findbar').hidden = true;
  findPane?.search.clearDecorations();
  findPane?.term.clearSelection();
  findPane?.term.focus();
  return true;
}
$('#find-input').oninput = () => find(1);
$('#find-input').onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); find(e.shiftKey ? -1 : 1); } };
$('#find-next').onclick = () => find(1);
$('#find-prev').onclick = () => find(-1);
$('#find-close').onclick = closeFind;

// ---------------------------------------------------------------- command palette
let paletteItems = [], paletteIndex = 0;

function openPalette() {
  const actions = Object.entries(ACTIONS).filter(([id]) => id !== 'commandPalette')
    .map(([id, a]) => ({ name: a[0], hint: bindingsFor(id)[0], run: a[2] }));
  paletteItems = [
    ...actions,
    ...S.profiles.map(p => ({ name: `New tab: ${p.name}`, run: () => newTab({ profile: p.name }) })),
    ...S.agents.map(a => ({ name: `Switch agent: ${a.name}`, run: () => switchAgent(a.id) })),
    ...['right', 'left', 'bottom', 'top'].map(pos => ({ name: `Move agent pane: ${pos}`, run: () => { if (active) { active.position = pos; layoutTab(active); } } })),
    ...S.schemes.map(s => ({ name: `Color scheme: ${s.name}`, run: () => setPaneScheme(s.name) })),
    ...tabs.map(t => ({ name: `Go to tab: ${tabTitle(t)}`, hint: t.type === 'sbx' ? '' : shortPath(t.cwd), run: () => activate(t) })),
  ];
  $('#palette').hidden = false;
  $('#palette-input').value = '';
  renderPalette();
  $('#palette-input').focus();
}

function filteredPalette() {
  const words = $('#palette-input').value.toLowerCase().split(/\s+/).filter(Boolean);
  return paletteItems.filter(i => words.every(w => i.name.toLowerCase().includes(w)));
}

function renderPalette() {
  const items = filteredPalette();
  paletteIndex = clamp(paletteIndex, 0, Math.max(0, items.length - 1));
  $('#palette-list').replaceChildren(...items.map((it, i) => {
    const li = el('li', { className: i === paletteIndex ? 'selected' : '', role: 'option' },
      el('span', { textContent: it.name }), it.hint && el('kbd', { textContent: it.hint }));
    li.onclick = () => runPalette(it);
    return li;
  }));
  $('#palette-list').children[paletteIndex]?.scrollIntoView({ block: 'nearest' });
}

function runPalette(item) {
  closePalette();
  item.run();
}

function closePalette() {
  if ($('#palette').hidden) return false;
  $('#palette').hidden = true;
  if (active) focusPane(active, active.focused);
  return true;
}

$('#palette-input').oninput = () => { paletteIndex = 0; renderPalette(); };
$('#palette-input').onkeydown = e => {
  const items = filteredPalette();
  if (e.key === 'ArrowDown') { paletteIndex = (paletteIndex + 1) % Math.max(1, items.length); renderPalette(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { paletteIndex = (paletteIndex - 1 + items.length) % Math.max(1, items.length); renderPalette(); e.preventDefault(); }
  if (e.key === 'Enter' && items[paletteIndex]) runPalette(items[paletteIndex]);
};
$('#palette').onclick = e => { if (e.target.id === 'palette') closePalette(); };

function closeOverlays() {
  if (!$('#menu').hidden) { $('#menu').hidden = true; return true; }
  return closePalette() || closeSettings() || closeFind();
}

// ---------------------------------------------------------------- form helpers
const set = (key, value) => api.updateSettings({ [key]: value });
const field = (label, control, help) =>
  el('label', { className: 'field' }, el('span', { textContent: label }), control, help && el('small', { textContent: help }));

function select(value, options, onChange) {
  const s = el('select');
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    s.append(el('option', { value: v, textContent: l, selected: v === value }));
  }
  s.onchange = () => onChange(s.value);
  return s;
}
function checkbox(checked, onChange, props = {}) {
  const c = el('input', { type: 'checkbox', checked, ...props });
  c.onchange = () => onChange(c.checked);
  return c;
}
const toggle = (checked, onChange, props = {}) => {
  const c = checkbox(checked, onChange, { className: 'switch', ...props });
  c.setAttribute('role', 'switch');
  return c;
};
function input(value, onChange, type = 'text') {
  const i = el('input', { type, value: value ?? '' });
  i.onchange = () => onChange(type === 'number' ? Number(i.value) : i.value);
  return i;
}
function swatches(name) {
  const s = scheme(name);
  return el('div', { className: 'swatches', title: s.name },
    ...['background', 'foreground', 'black', 'red', 'green', 'yellow', 'blue', 'purple', 'cyan', 'white',
      'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightPurple', 'brightCyan', 'brightWhite']
      .map(k => el('span', { style: `background:${s[k]}`, title: k })));
}
const schemeOptions = withDefault => [...(withDefault ? [['', 'Use default']] : []), ...S.schemes.map(s => s.name)];
function browseButton(onPick) {
  const b = el('button', { textContent: 'Browse…', type: 'button' });
  b.onclick = async e => { e.preventDefault(); const d = await api.openFolder(); if (d) onPick(d); };
  return b;
}

// ---------------------------------------------------------------- settings UI
let settingsSection = 'General';

function openSettings(section) {
  if (section) settingsSection = section;
  $('#settings').hidden = false;
  renderSettings();
  $('#settings-nav button.active')?.focus();
}

function closeSettings() {
  if ($('#settings').hidden) return false;
  $('#settings').hidden = true;
  if (active) focusPane(active, active.focused);
  return true;
}
$('#settings-close').onclick = closeSettings;

const SECTIONS = {
  General: () => [
    field('Default shell profile', select(S.defaultProfile, S.profiles.map(p => p.name), v => set('defaultProfile', v)),
      'Shell used in the terminal pane of new tabs.'),
    field('Default agent', select(S.defaultAgent, [...S.agents.map(a => [a.id, a.name]), ['', 'None (shell only)']], v => set('defaultAgent', v)),
      'Agent CLI started in the agent pane of new tabs.'),
    field('Starting directory', el('div', { className: 'row' },
      input(S.startingDirectory, v => set('startingDirectory', v)), browseButton(d => set('startingDirectory', d))),
    'Folder for new tabs. Use "Open folder…" (Ctrl+Shift+O) to open a tab somewhere else.'),
    field('Agent pane position', select(S.agentPanePosition, ['right', 'left', 'bottom', 'top'], v => set('agentPanePosition', v))),
    field('Agent pane size (%)', input(S.agentPaneSize, v => set('agentPaneSize', clamp(v, 10, 90)), 'number')),
    field('Copy on select', checkbox(S.copyOnSelect, v => set('copyOnSelect', v))),
    field('Drag selects text in apps that use the mouse', checkbox(S.dragToSelect, v => set('dragToSelect', v)),
      'In Claude Code and other full-screen CLIs, dragging selects text (clicks still go to the app). Off: drags go to the app; Shift+drag selects.'),
    field('Confirm before closing a window with several tabs', checkbox(S.confirmOnClose, v => set('confirmOnClose', v)),
      '"Don\'t ask me again" in the close dialog turns this off; turn it back on here.'),
    field('Reopen tabs on launch', checkbox(S.restoreSession, v => set('restoreSession', v)),
      'Reopens your tabs, folders and split layout. Claude Code, Copilot and OpenCode resume their last conversation (--continue).'),
    field('Setup wizard', Object.assign(el('button', { textContent: 'Run setup again', type: 'button', className: 'secondary' }),
      { onclick: e => { e.preventDefault(); closeSettings(); runWizard(); } })),
  ],
  Tabs: () => [
    field('Tab layout', select(S.tabLayout, [['vertical', 'Vertical (sidebar)'], ['horizontal', 'Horizontal (top)']], v => set('tabLayout', v))),
    field('Sidebar width (px)', input(S.sidebarWidth, v => set('sidebarWidth', clamp(v, 140, 600)), 'number')),
    field('Show sidebar', checkbox(S.sidebarVisible, v => set('sidebarVisible', v)), 'Toggle with Ctrl+Shift+S.'),
    el('h3', { textContent: 'Tab details' }),
    field('Directory', checkbox(S.tabMetadata.directory, v => set('tabMetadata', { directory: v }))),
    field('Git branch and status', checkbox(S.tabMetadata.git, v => set('tabMetadata', { git: v }))),
    field('Agent and model', checkbox(S.tabMetadata.model, v => set('tabMetadata', { model: v })),
      'Claude Code: read live from its session transcript. Others: from --model in the agent command or the CLI\'s config file.'),
    field('Agent activity indicator', checkbox(S.tabMetadata.activity, v => set('tabMetadata', { activity: v }))),
  ],
  Appearance: () => [
    field('Theme', select(S.theme, ['dark', 'light', 'system'], v => set('theme', v))),
    field('Default color scheme', select(S.colorScheme, schemeOptions(false), v => set('colorScheme', v))),
    swatches(S.colorScheme),
    field('Font face', input(S.fontFace, v => set('fontFace', v))),
    field('Font size', input(S.fontSize, v => set('fontSize', clamp(v, 6, 72)), 'number'), 'Ctrl+scroll or Ctrl+= / Ctrl+- changes it temporarily.'),
    field('Cursor shape', select(S.cursorShape, ['bar', 'block', 'underline'], v => set('cursorShape', v))),
    field('Cursor blink', checkbox(S.cursorBlink, v => set('cursorBlink', v))),
    field('History size (lines)', input(S.historySize, v => set('historySize', Math.max(0, v)), 'number')),
  ],
  Profiles: () => [
    el('p', { className: 'note', textContent: 'Shells detected on this machine. Add or hide profiles in settings.json.' }),
    el('table', { className: 'list' },
      el('tr', {}, el('th', { textContent: 'Name' }), el('th', { textContent: 'Command' }), el('th', { textContent: 'Color scheme' })),
      ...S.profiles.map(p => el('tr', {},
        el('td', { textContent: p.name }),
        el('td', { className: 'muted', textContent: [p.commandline, ...(p.args || [])].join(' ') }),
        el('td', {}, select(p.colorScheme || '', schemeOptions(true), v => set('profiles', [{ name: p.name, colorScheme: v || undefined }])))))),
  ],
  Agents: () => [
    el('p', { className: 'note', textContent: 'The agent pane runs this command in your shell, exactly as if you typed it. Add flags such as --model or --continue here.' }),
    el('table', { className: 'list' },
      el('tr', {}, el('th', { textContent: 'Agent' }), el('th', { textContent: 'Command' }), el('th', { textContent: 'Color scheme' })),
      ...S.agents.map(a => el('tr', {},
        el('td', { textContent: a.name }),
        el('td', {}, Object.assign(input(a.command, v => v.trim() && set('agents', [{ id: a.id, command: v.trim() }])), { className: 'command' })),
        el('td', {}, select(a.colorScheme || '', schemeOptions(true), v => set('agents', [{ id: a.id, colorScheme: v || undefined }])))))),
  ],
  Sandboxes: () => [
    el('p', { className: 'note', textContent: 'Docker Sandboxes runs agents in isolated containers. When enabled, a pinned "sbx" tab runs the sbx dashboard, and sandboxes you open from it with "External terminal" open here as new tabs.' }),
    field('Docker Sandboxes support', toggle(S.sandboxEnabled, v => set('sandboxEnabled', v))),
    field('sbx command', input(S.sandboxCommand, v => set('sandboxCommand', v.trim() || 'sbx')), 'Name or full path of the sbx executable.'),
  ],
  Actions: () => [
    el('p', { className: 'note', textContent: 'Click a shortcut and press the new key combination. Backspace unbinds it. Edit settings.json to bind several keys to one action.' }),
    el('table', { className: 'list' },
      el('tr', {}, el('th', { textContent: 'Action' }), el('th', { textContent: 'Shortcut' }), el('th')),
      ...Object.entries(ACTIONS).map(([id, a]) => {
        const keys = el('input', { className: 'keys', readOnly: true, value: bindingsFor(id).join(', '), placeholder: 'Unbound', ariaLabel: `Shortcut for ${a[0]}` });
        keys.onkeydown = e => {
          if (e.key === 'Tab' || e.key === 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Backspace' || e.key === 'Delete') return set('keybindings', { [id]: '' });
          const combo = Keys.eventToKey(e);
          if (combo) set('keybindings', { [id]: combo });
        };
        const reset = el('button', { textContent: 'Reset', title: 'Restore default shortcut', disabled: !(id in S.keybindings) });
        reset.onclick = () => set('keybindings', { [id]: null });
        return el('tr', {}, el('td', { textContent: a[0] }), el('td', {}, keys), el('td', {}, reset));
      })),
  ],
};

function renderSettings() {
  if ($('#settings').hidden) return;
  const nav = Object.keys(SECTIONS).map(name => {
    const b = el('button', { textContent: name, className: name === settingsSection ? 'active' : '' });
    b.onclick = () => { settingsSection = name; renderSettings(); };
    return b;
  });
  const fileBtn = el('button', { textContent: 'Open settings.json' });
  fileBtn.onclick = () => api.openSettingsFile('user');
  $('#settings-nav').replaceChildren(...nav, el('span', { className: 'spacer' }), fileBtn);
  const scroll = $('#settings-body').scrollTop;
  $('#settings-body').replaceChildren(el('h2', { textContent: settingsSection }), ...SECTIONS[settingsSection]());
  $('#settings-body').scrollTop = scroll;
}

// ---------------------------------------------------------------- first-run setup wizard
// Edits a draft and saves it in one go on Finish (or marks setup done on Skip).
async function runWizard() {
  const detect = await api.detectSetup().catch(() => ({ agents: {}, sbx: false }));
  return new Promise(resolve => {
    const installed = id => detect.agents[id];
    const firstInstalled = S.agents.find(a => installed(a.id))?.id;
    const d = {
      defaultAgent: S.setupComplete || installed(S.defaultAgent) ? S.defaultAgent : firstInstalled || S.defaultAgent,
      defaultProfile: S.defaultProfile, startingDirectory: S.startingDirectory,
      tabLayout: S.tabLayout, agentPanePosition: S.agentPanePosition, theme: S.theme, colorScheme: S.colorScheme,
      tabMetadata: { ...S.tabMetadata }, sandboxEnabled: S.sandboxEnabled && detect.sbx,
    };
    let step = 0;
    const radio = (group, value, current, label, sub, onPick, disabled) => {
      const r = el('input', { type: 'radio', name: group, value, checked: value === current, disabled });
      r.onchange = () => onPick(value);
      return el('label', { className: 'choice' + (disabled ? ' disabled' : '') }, r,
        el('span', {}, el('strong', { textContent: label }), sub && el('small', { textContent: sub })));
    };
    const steps = [
      ['Choose your default agent', 'Each tab runs this agent CLI next to your shell, exactly as it looks in a normal terminal. You can switch per tab later.', () => [
        el('div', { className: 'choices' },
          ...S.agents.map(a => radio('agent', a.id, d.defaultAgent, a.name,
            installed(a.id) ? `Installed · runs "${a.command}"` : `Not found on PATH ("${a.command}")`, v => { d.defaultAgent = v; })),
          radio('agent', '', d.defaultAgent, 'None', 'Tabs open with only a shell', v => { d.defaultAgent = v; })),
      ]],
      ['Shell and starting folder', 'The shell shown beside the agent, and the folder new tabs open in.', () => [
        field('Default shell', select(d.defaultProfile, S.profiles.map(p => p.name), v => { d.defaultProfile = v; })),
        field('Starting directory', el('div', { className: 'row' },
          Object.assign(input(d.startingDirectory, v => { d.startingDirectory = v; }), { id: 'wiz-dir' }),
          browseButton(dir => { d.startingDirectory = dir; $('#wiz-dir').value = dir; })),
        'Use ~ for your home folder. Ctrl+Shift+O opens a tab in any other folder.'),
      ]],
      ['Layout and look', 'All of this can be changed later in Settings (Ctrl+,).', () => [
        field('Tabs', select(d.tabLayout, [['vertical', 'Vertical sidebar'], ['horizontal', 'Horizontal, along the top']], v => { d.tabLayout = v; })),
        field('Agent pane position', select(d.agentPanePosition, ['right', 'left', 'bottom', 'top'], v => { d.agentPanePosition = v; })),
        field('Theme', select(d.theme, ['dark', 'light', 'system'], v => { d.theme = v; })),
        field('Color scheme', select(d.colorScheme, schemeOptions(false), v => { d.colorScheme = v; renderStep(); })),
        swatches(d.colorScheme),
        field('Show in each tab', el('div', { className: 'checks' },
          ...[['directory', 'Directory'], ['git', 'Git branch and status'], ['model', 'Agent and model']].map(([k, l]) =>
            el('label', {}, checkbox(d.tabMetadata[k], v => { d.tabMetadata[k] = v; }), ` ${l}`)))),
      ]],
      ['Docker Sandboxes', 'Run agents in isolated containers with Docker Sandboxes (sbx).', () => [
        field('Docker Sandboxes support', toggle(d.sandboxEnabled, v => { d.sandboxEnabled = v; }, { disabled: !detect.sbx }),
          detect.sbx
            ? 'Adds a pinned "sbx" tab running the sbx dashboard. Sandboxes you open from it with "External terminal" open here as new tabs.'
            : 'sbx was not found on PATH. Install Docker Sandboxes (docs.docker.com/ai/sandboxes), then enable this in Settings → Sandboxes.'),
      ]],
    ];
    const finish = async patch => {
      $('#wizard').hidden = true;
      await api.updateSettings({ ...patch, setupComplete: true });
      apply(await api.getSettings());
      resolve();
    };
    const renderStep = () => {
      const [title, intro, body] = steps[step];
      const back = el('button', { textContent: 'Back', type: 'button', className: 'secondary', disabled: step === 0 });
      back.onclick = () => { step--; renderStep(); };
      const last = step === steps.length - 1;
      const next = el('button', { textContent: last ? 'Finish' : 'Next', type: 'button', className: 'primary' });
      next.onclick = () => { if (last) finish(d); else { step++; renderStep(); } };
      const skip = el('button', { textContent: 'Skip setup', type: 'button', className: 'link' });
      skip.onclick = () => finish({});
      $('#wizard-box').replaceChildren(
        el('div', { className: 'wizard-head' },
          el('div', { className: 'wizard-steps', textContent: `Step ${step + 1} of ${steps.length}` }),
          el('h2', { textContent: step === 0 ? `Welcome to Agent Terminal. ${title}` : title }),
          el('p', { className: 'note', textContent: intro })),
        el('div', { className: 'wizard-body' }, ...body()),
        el('div', { className: 'wizard-foot' }, skip, el('span', { className: 'spacer' }), back, next));
      next.focus();
    };
    $('#wizard').hidden = false;
    renderStep();
  });
}

// ---------------------------------------------------------------- apply settings
function applyTheme() {
  const dark = S.theme === 'dark' || (S.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => S && applyTheme());

let toastTimer;
function toast(msg, info = false, ms = 8000) {
  $('#toast').textContent = msg;
  $('#toast').classList.toggle('info', info);
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, ms);
}
const notify = msg => toast(msg, true, 1500);

// Adds or removes the pinned sbx tab when the setting is switched.
function syncSbxTab() {
  const was = sandboxWasEnabled;
  sandboxWasEnabled = S.sandboxEnabled;
  if (!started || was === S.sandboxEnabled) return;
  const sbxTab = tabs.find(t => t.type === 'sbx');
  if (S.sandboxEnabled && !sbxTab) ensureSbxTab({ activate: false });
  if (!S.sandboxEnabled && sbxTab && tabs.length > 1) closeTab(sbxTab);
}

function apply(payload) {
  S = payload.settings;
  HOME = payload.home;
  if (payload.error) toast(payload.error);
  buildKeymap();
  applyTheme();
  $('#app').className = [S.tabLayout === 'horizontal' ? 'horizontal' : 'vertical', !S.sidebarVisible && 'sidebar-hidden'].filter(Boolean).join(' ');
  document.documentElement.style.setProperty('--sidebar-w', `${S.sidebarWidth}px`);
  for (const t of tabs) for (const p of tabPanes(t)) p.applySettings();
  if (active) document.documentElement.style.setProperty('--term-bg', scheme(primaryPane(active).schemeName()).background);
  const agentName = agentDef(S.defaultAgent)?.name;
  $('#new-agent-tab').hidden = !agentName;
  $('#new-agent-tab').textContent = `+ ${agentName || 'Agent'}`;
  $('#new-agent-tab').title = `New tab with ${agentName} and a terminal (Ctrl+Shift+T)`;
  syncSbxTab();
  renderTabs();
  renderSettings();
  requestAnimationFrame(() => { for (const t of tabs) for (const p of tabPanes(t)) p.refit(); });
}

(async () => {
  apply(await api.getSettings());
  api.onSettings(apply);
  api.onSbxOpen(openSandboxTab);
  if (!S.setupComplete) await runWizard();
  sandboxWasEnabled = S.sandboxEnabled;
  const dir = new URLSearchParams(location.search).get('dir');
  const session = await api.getSession();
  if (session?.tabs?.length) {
    await restoreSession(session);
    if (dir) await newTab({ cwd: dir });
  } else {
    if (S.sandboxEnabled) ensureSbxTab({ activate: false });
    await newTab(dir ? { cwd: dir } : {});
  }
  started = true;
})();
