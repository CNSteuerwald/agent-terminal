'use strict';
/* global Terminal, FitAddon, SearchAddon, WebLinksAddon, Keys, AgentIcons, api */

const $ = s => document.querySelector(s);
function el(tag, props = {}, ...children) {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.filter(c => c != null && c !== false));
  return e;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

let S = null;            // effective settings from main
let HOME = '';
let VERSION = '';
let PACKAGED = false;    // installed copy (vs npm start): enables Uninstall
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

// ---------------------------------------------------------------- actions
// [name, default keys, run]. run() returning false means "not handled": the key goes to the terminal.
const ACTIONS = {
  newTab: ['New tab (agent + terminal)', 'ctrl+shift+t', () => newTab()],
  newShellTab: ['New terminal tab (no agent)', 'ctrl+alt+t', () => newTab({ agent: '' })],
  openFolder: ['Open folder in new tab…', 'ctrl+shift+o', openFolderTab],
  duplicateTab: ['Duplicate tab (same panes and layout)', 'ctrl+shift+d', () => {
    if (active?.type === 'workspace') createTab({ type: 'workspace', cwd: active.cwd, color: active.color, layout: Layout.serialize(active.root, paneJson) });
  }],
  closePane: ['Close pane (the tab closes with its last pane)', 'ctrl+shift+w', () => closePane(focusedPane())],
  newTerminalPane: ['New terminal pane', 'ctrl+shift+e', () => addPane(active, { kind: 'shell' })],
  splitRight: ['Split right: new terminal', 'alt+shift+=', () => addPane(active, { kind: 'shell' }, { placement: 'right' })],
  splitDown: ['Split down: new terminal', 'alt+shift+-', () => addPane(active, { kind: 'shell' }, { placement: 'down' })],
  openAgentPane: ['Open or focus agent pane', 'ctrl+shift+.', () => openAgentPane()],
  focusAgentPane: ['Switch focus between terminal and agent', 'ctrl+shift+i', () => toggleAgentFocus()],
  moveFocusLeft: ['Focus pane to the left', 'alt+left', () => moveFocus('left')],
  moveFocusRight: ['Focus pane to the right', 'alt+right', () => moveFocus('right')],
  moveFocusUp: ['Focus pane above', 'alt+up', () => moveFocus('up')],
  moveFocusDown: ['Focus pane below', 'alt+down', () => moveFocus('down')],
  renamePane: ['Rename pane', '', () => focusedPane() && renamePane(focusedPane())],
  restartPane: ['Restart focused pane', '', () => focusedPane()?.restart()],
  movePaneToNewTab: ['Move pane to a new tab', '', () => { const p = focusedPane(); if (p && tabPanes(p.tab).length > 1) movePaneToTab(p, null); }],
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
  toggleSplitOrientation: ['Toggle split orientation', '', toggleSplitOrientation],
  togglePaneZoom: ['Zoom focused pane (toggle)', '', togglePaneZoom],
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
    if (!p?.isAgent || !p.ptyId) return false;
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
  return S.schemes.find(s => s.name === name) || S.schemes[0];
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
// A pane runs one process: a shell, an agent CLI, the sbx dashboard, or a sandbox session.
// spec: { kind: 'shell', profile } | { kind: 'agent', agentId } | { kind: 'sbx' } | { kind: 'sandbox', sandbox },
// plus optional cwd, title and resume.
const agentDef = id => S.agents.find(a => a.id === id);
const PANE_ICONS = { shell: '›_', agent: '✦', sbx: '⬢', sandbox: '⧉' };

// ---------------------------------------------------------------- agent icons
// Each agent has an icon (icons.js) and a color, chosen in Settings → Agents.
const HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
function agentLook(agentId) {
  const a = agentDef(agentId);
  return { icon: AgentIcons.has(a?.icon) ? a.icon : 'spark', color: HEX_COLOR.test(a?.iconColor || '') ? a.iconColor : null };
}
// A colored tab (right-click → Tab color) paints its agents' icons in its color.
function paneLook(p) {
  const look = agentLook(p.kind === 'sandbox' ? p.sandbox?.agent : p.agentId);
  return HEX_COLOR.test(p.tab?.color || '') ? { ...look, color: p.tab.color } : look;
}

// state: '' | 'idle' | 'working' | 'attention' | 'done'. A null color inherits --ai-color (else the accent).
function iconEl({ icon, color }, state = '', label = '') {
  const span = el('span', { className: `agent-icon ai-${icon} ${state}`.trim() });
  span.innerHTML = AgentIcons.svg(icon); // static markup from icons.js, never user text
  if (color) span.style.setProperty('--ai-color', color);
  span.style.setProperty('--ai-phase', `-${Math.round(performance.now() % 2400)}ms`); // see styles.css
  if (label) { span.setAttribute('role', 'img'); span.ariaLabel = label; } else span.ariaHidden = 'true';
  return span;
}

class Pane {
  constructor(tab, spec) {
    this.tab = tab;
    this.kind = spec.kind;
    this.profile = spec.profile || S.defaultProfile;
    this.agentId = spec.agentId || null;
    this.sandbox = spec.sandbox || null;
    this.cwd = spec.cwd || tab.cwd;   // shells: live folder; agents: where they started
    this.customTitle = spec.title || null;
    this.resume = !!spec.resume;      // next start resumes the agent's last conversation (restored tabs)
    this.ptyId = null;
    this.exited = false;
    this.lastInput = 0;   // output right after input/resize/focus is an echo or redraw, not agent work
    this.lastWork = 0;
    this.host = el('div', { className: 'term' });
    this.el = el('div', { className: `pane pane-${this.kind}` }, this.host);
  }

  get isAgent() { return this.kind === 'agent' || this.kind === 'sandbox'; }

  name() {
    if (this.kind === 'shell') return this.profile;
    if (this.kind === 'agent') return agentDef(this.agentId)?.name || this.agentId;
    if (this.kind === 'sbx') return 'Docker Sandboxes';
    return `Sandbox: ${this.sandbox.name}`;
  }

  // Tab text: your name for it, else what runs in it (shells also show their folder).
  label() { return this.customTitle || (this.kind === 'shell' ? `${this.profile} · ${basename(this.cwd)}` : this.name()); }

  options() {
    return {
      fontFamily: S.fontFace, fontSize: clamp(S.fontSize + fontDelta, 6, 72),
      cursorStyle: S.cursorShape, cursorBlink: S.cursorBlink, scrollback: S.historySize,
      theme: xtermTheme(S.colorScheme),
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
    t.onTitleChange(title => { this.title = title; updatePaneTab(this); });
    t.textarea.addEventListener('focus', () => { this.lastInput = Date.now(); setFocused(this.tab, this); });
    if (this.kind === 'shell') {
      // The shell reports its folder at each prompt (see shell integration in settings.js).
      t.parser.registerOscHandler(9, data => {
        const m = data.match(/^9;"?([^"]*)"?$/);
        if (m) setPaneCwd(this, m[1]);
        return !!m; // other OSC 9 messages (notifications) are not ours
      });
      t.parser.registerOscHandler(7, data => {
        try { setPaneCwd(this, decodeURIComponent(new URL(data).pathname)); } catch { /* not a file URL */ }
        return true;
      });
    }
    // Right-click, like Windows Terminal: copy the selection if there is one, otherwise paste.
    this.host.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (!copySelection(this)) { this.tab.focused = this; ACTIONS.paste[2](); }
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
    const keepsSelection = () => this.term.modes.mouseTrackingMode !== 'none' && this.term.hasSelection();
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

  applySettings() {
    if (!this.term) return;
    Object.assign(this.term.options, this.options());
    updatePaneTab(this);
    this.refit();
  }

  refit() {
    if (!this.term || !this.host.offsetWidth || !this.host.offsetHeight) return;
    try { this.fit.fit(); } catch { /* not rendered yet */ }
  }

  spawnRequest() {
    const base = { kind: this.kind, cwd: this.cwd, cols: this.term.cols, rows: this.term.rows };
    if (this.kind === 'shell') return { ...base, name: this.profile };
    if (this.kind === 'agent') return { ...base, name: this.agentId, resume: this.resume };
    if (this.kind === 'sandbox') return { ...base, name: this.sandbox.name, args: this.sandbox.args };
    return base; // sbx
  }

  async start() {
    this.exited = false;
    this.term.reset();
    this.refit();
    try {
      const { id, cwd } = await api.spawn(this.spawnRequest());
      if (this.disposed) return api.kill(id);
      if (this.kind === 'shell') setPaneCwd(this, cwd);
      else {
        this.cwd = cwd;
        if (!tabPanes(this.tab).some(p => p.kind === 'shell')) this.tab.cwd = cwd;
      }
      if (this.kind === 'agent') this.agentStarted = Date.now();
      this.resume = false;
      // Agents only work after you give them something: startup banners and resumed history don't count.
      this.armed = false;
      this.ptyId = id;
      // Resizes during the await were dropped (no ptyId yet); otherwise the shell keeps the old row count.
      api.resize(id, this.term.cols, this.term.rows);
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

const paneJson = p => ({ kind: p.kind, profile: p.profile, agentId: p.agentId, sandbox: p.sandbox, cwd: p.cwd, title: p.customTitle });

function deliver(p, ev) {
  if ('exit' in ev) return p.markExited(ev.exit);
  p.term.write(ev.data);
  const now = Date.now();
  if (p.isAgent && p.armed && now - p.lastInput > 500) {
    p.lastWork = now;
    p.tab.lastAgentOutput = now;
    p.tab.busySince ||= now;
  }
}

// Called with a shell's folder reports. Only accepts real host paths (not e.g. WSL's /home/...).
// The sidebar and git status follow the terminal you used last.
function setPaneCwd(pane, dir) {
  if (api.platform === 'win32') {
    dir = dir.replace(/^\/([a-zA-Z]):?\//, '$1:/').replace(/\//g, '\\'); // file:///C:/x and Git Bash /c/x
    if (!/^[a-zA-Z]:\\/.test(dir)) return;
  } else if (!dir.startsWith('/')) return;
  const changed = pane.cwd !== dir;
  pane.cwd = dir;
  const tab = pane.tab;
  if (!tabPanes(tab).includes(tab.cwdPane)) tab.cwdPane = pane;
  if (tab.cwdPane === pane && tab.cwd !== dir) {
    tab.cwd = dir;
    renderTabs();
    refreshInfo([tab]);
  }
  if (changed) updatePaneTab(pane);
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

const tabPanes = tab => Layout.panes(tab?.root);
const primaryPane = tab => tabPanes(tab)[0];
const primaryAgent = tab => (tab.focused?.kind === 'agent' && tabPanes(tab).includes(tab.focused) && tab.focused)
  || tabPanes(tab).find(p => p.kind === 'agent') || null;

function focusedPane(tab = active) {
  const all = tabPanes(tab);
  return all.includes(tab?.focused) ? tab.focused : all[0] || null;
}

// ---------------------------------------------------------------- tabs
// Tab types: 'workspace' (terminals + agents in one folder), 'sbx' (the Docker Sandboxes TUI, full window),
// 'sandbox' (a sandbox session opened from the sbx TUI + a host shell in its workspace).
// Each tab's panes live in tab.root, a layout tree of split groups (see layout.js).

// The first layout of a new tab: a terminal and the agent, arranged per the "agentPanePosition" setting.
// Also reads tabs saved by older versions (shell/agent/position/size).
function initialLayout(tab, o) {
  const shell = o.shell !== false && tab.type !== 'sbx' && new Pane(tab, { kind: 'shell', profile: o.profile, cwd: tab.cwd });
  const agentSpec = tab.type === 'sbx' ? { kind: 'sbx' }
    : tab.type === 'sandbox' ? { kind: 'sandbox', sandbox: tab.sandbox }
      : o.agentId && o.agent !== false && { kind: 'agent', agentId: o.agentId, cwd: o.agentCwd || tab.cwd, resume: o.resume };
  const agent = agentSpec && new Pane(tab, agentSpec);
  if (!shell || !agent) return Layout.group([shell || agent].filter(Boolean));
  const pos = o.position || S.agentPanePosition;
  if (pos === 'tab') return Layout.group([shell, agent], 1);
  const g = Layout.group([shell]);
  const root = Layout.splitAt(g, g, Layout.group([agent]), pos);
  const agentShare = clamp((o.size || S.agentPaneSize) / 100, 0.1, 0.9);
  root.sizes = root.children.map(c => (c.panes.includes(agent) ? agentShare : 1 - agentShare));
  return root;
}

async function createTab(o) {
  const tab = {
    id: ++tabSeq, type: o.type, color: o.color || null, cwd: o.cwd ?? S.startingDirectory, title: o.title || null,
    sandbox: o.sandbox || null, root: null, focused: null, cwdPane: null, zoom: null,
    info: {}, attention: false, done: false, lastAgentOutput: 0, busySince: 0,
  };
  tab.view = el('div', { className: `view type-${tab.type}` });
  if (o.atStart) tabs.unshift(tab);
  else tabs.push(tab);
  $('#views').append(tab.view);
  if (o.adopt) {
    o.adopt.tab = tab;
    tab.root = Layout.group([o.adopt]);
  } else {
    tab.root = o.layout && Layout.deserialize(o.layout, j => new Pane(tab, { ...j, resume: o.resume }));
    tab.root ||= initialLayout(tab, o);
  }
  tab.focused = tabPanes(tab).find(p => p.isAgent) || tabPanes(tab)[0];
  renderLayout(tab);
  // Background tabs (e.g. restored on launch) start their terminals when first activated.
  if (o.activate === false) renderTabs();
  else { activate(tab); await tab.starting; }
  refreshInfo([tab]);
  return tab;
}

// Opens and starts panes that have no terminal yet. The tab's view must be visible: xterm measures its cell size.
function startPanes(tab) {
  const fresh = tabPanes(tab).filter(p => !p.term);
  if (!fresh.length) return tab.starting;
  fresh.forEach(p => p.open());
  tab.starting = Promise.all(fresh.map(p => p.start())).then(renderTabs); // start() fits synchronously before awaiting
  return tab.starting;
}

// A plain new tab uses the default template when one is set; asking for a profile or agent skips it.
function newTab({ cwd, profile, agent, template } = {}) {
  const name = template ?? (profile === undefined && agent === undefined ? S.defaultTemplate : '');
  const tpl = name && S.templates.find(t => t.name === name);
  if (tpl) return createTab({ type: 'workspace', cwd, layout: tpl.layout });
  return createTab({ type: 'workspace', cwd, profile, agentId: agent ?? S.defaultAgent });
}

// Adds a pane to a tab: as a tab in a group, or split off to the right / below it.
function addPane(tab, spec, { group, placement = S.newPanePlacement } = {}) {
  if (!tab || tab.type === 'sbx') return null;
  const g = group || Layout.groupOf(tab.root, focusedPane(tab)) || Layout.groups(tab.root)[0];
  const p = new Pane(tab, { ...spec, cwd: spec.cwd || focusedPane(tab)?.cwd || tab.cwd });
  if (placement === 'right' || placement === 'down') tab.root = Layout.splitAt(tab.root, g, Layout.group([p]), placement === 'right' ? 'right' : 'bottom');
  else Layout.addToGroup(g, p);
  tab.zoom = null;
  renderLayout(tab);
  p.open();
  p.start();
  focusPane(tab, p);
  renderTabs();
  return p;
}

function closePane(pane) {
  const tab = pane?.tab;
  if (!tab) return;
  pane.dispose();
  tab.root = Layout.removePane(tab.root, pane);
  if (!tab.root) return closeTab(tab);
  if (tab.cwdPane === pane) tab.cwdPane = null;
  if (tab.focused === pane) tab.focused = null;
  if (tab.zoom && !Layout.groups(tab.root).includes(tab.zoom)) tab.zoom = null;
  renderLayout(tab);
  if (tab === active) focusPane(tab, focusedPane(tab));
  renderTabs();
}

// Moves a pane to another tab (into its focused group), or to a new tab when dest is null.
function movePaneToTab(pane, dest) {
  const src = pane.tab;
  src.root = Layout.removePane(src.root, pane);
  if (src.focused === pane) src.focused = null;
  if (src.cwdPane === pane) src.cwdPane = null;
  if (dest) {
    pane.tab = dest;
    Layout.addToGroup(Layout.groupOf(dest.root, focusedPane(dest)) || Layout.groups(dest.root)[0], pane);
    renderLayout(dest);
  }
  if (src.root) renderLayout(src);
  else closeTab(src); // nothing left behind; the moved pane keeps running
  if (dest) { activate(dest); focusPane(dest, pane); }
  else createTab({ type: pane.kind === 'sandbox' ? 'sandbox' : 'workspace', sandbox: pane.sandbox, cwd: pane.cwd, adopt: pane });
  renderTabs();
}

function openAgentPane(tab = active) {
  if (!tab || tab.type === 'sbx') return;
  const agents = tabPanes(tab).filter(p => p.isAgent);
  if (agents.length) return focusPane(tab, agents[(agents.indexOf(tab.focused) + 1) % agents.length]);
  const placement = S.newPanePlacement === 'tab' ? 'right' : S.newPanePlacement;
  if (tab.type === 'sandbox') return addPane(tab, { kind: 'sandbox', sandbox: tab.sandbox }, { placement });
  const agentId = S.defaultAgent || S.agents[0]?.id;
  if (agentId) addPane(tab, { kind: 'agent', agentId }, { placement });
}

function toggleAgentFocus(tab = active) {
  if (!tab) return;
  const cur = focusedPane(tab);
  const target = cur?.isAgent
    ? (tabPanes(tab).includes(tab.cwdPane) ? tab.cwdPane : tabPanes(tab).find(p => p.kind === 'shell'))
    : tabPanes(tab).find(p => p.isAgent);
  if (target) focusPane(tab, target);
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
  const open = tabs.find(t => t.type === 'sandbox' && t.sandbox?.name === name && tabPanes(t).some(p => p.kind === 'sandbox' && p.ptyId));
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

function activate(tab) {
  if (!tab) return;
  active = tab;
  tab.attention = false;
  tab.done = false;
  for (const t of tabs) t.view.classList.toggle('active', t === tab);
  startPanes(tab);
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

function focusPane(tab, pane) {
  if (!tab) return;
  pane = tabPanes(tab).includes(pane) ? pane : focusedPane(tab);
  if (!pane) return;
  const g = Layout.groupOf(tab.root, pane);
  if (tab.zoom && tab.zoom !== g) { tab.zoom = null; renderLayout(tab); }
  if (g.panes[g.active] !== pane) { g.active = g.panes.indexOf(pane); updateGroup(g); }
  setFocused(tab, pane);
  if (tab === active) pane.term?.focus();
}

// Records which pane has focus. Focusing a terminal also points the sidebar at its folder.
function setFocused(tab, pane) {
  tab.focused = pane;
  if (pane.kind === 'shell' && tab.cwdPane !== pane) {
    tab.cwdPane = pane;
    if (tab.cwd !== pane.cwd) { tab.cwd = pane.cwd; renderTabs(); refreshInfo([tab]); }
  }
  markFocused(tab);
}

function markFocused(tab) {
  for (const g of Layout.groups(tab.root)) g.box?.classList.toggle('focused', g.panes.includes(tab.focused));
}

function switchAgent(id) {
  const tab = active;
  if (tab?.type !== 'workspace') return;
  const p = focusedPane(tab);
  if (p?.kind !== 'agent') return addPane(tab, { kind: 'agent', agentId: id });
  p.agentId = id;
  p.title = null;
  tab.info.model = tab.info.modelLabel = null;
  p.applySettings();
  p.restart();
}

// ---------------------------------------------------------------- layout rendering
// Rebuilds the split/group DOM of a tab. Pane elements (and their running xterms) are moved, not recreated.
function renderLayout(tab) {
  if (!tab.root) return;
  const node = tab.zoom && Layout.groups(tab.root).includes(tab.zoom) ? tab.zoom : tab.root;
  const hadFocus = tab.view.contains(document.activeElement);
  tab.view.replaceChildren(buildNode(tab, node));
  tab.view.classList.toggle('zoomed', node !== tab.root);
  markFocused(tab);
  if (hadFocus) focusedPane(tab)?.term?.focus();
  scheduleSave();
}

function buildNode(tab, node) {
  if (node.kind === 'group') return buildGroup(tab, node);
  const box = el('div', { className: `split split-${node.dir}` });
  node.children.forEach((c, i) => {
    if (i) box.append(gutter(node, i - 1, box));
    const child = buildNode(tab, c);
    child.style.flex = `${node.sizes[i]} 1 0`;
    box.append(child);
  });
  return box;
}

function buildGroup(tab, g) {
  g.strip = el('div', { className: 'pane-strip', role: 'tablist' });
  g.body = el('div', { className: 'group-body' }, ...g.panes.map(p => p.el));
  g.box = el('div', { className: 'group' }, g.strip, g.body);
  g.box.addEventListener('pointerdown', () => { if (!g.panes.includes(tab.focused)) focusPane(tab, g.panes[g.active]); }, true);
  renderStrip(tab, g);
  updateGroup(g);
  return g.box;
}

// Shows the group's active pane; the others stay laid out (so xterm can measure them) but hidden.
function updateGroup(g) {
  g.panes.forEach((p, i) => {
    p.el.classList.toggle('inactive', i !== g.active);
    p.tabEl?.classList.toggle('active', i === g.active);
    p.tabEl?.setAttribute('aria-selected', String(i === g.active));
  });
  requestAnimationFrame(() => g.panes[g.active]?.refit());
  scheduleSave();
}

function renderStrip(tab, g) {
  const add = el('button', { className: 'strip-add', textContent: '+', title: 'New terminal or agent', ariaLabel: 'New terminal or agent' });
  add.onclick = () => showAddMenu(tab, g, add);
  g.strip.replaceChildren(...g.panes.map(p => paneTab(tab, p)), add);
}

function paneTab(tab, p) {
  const close = el('button', { className: 'ptab-close', textContent: '×' });
  close.onpointerdown = e => e.stopPropagation();
  close.onclick = e => { e.stopPropagation(); closePane(p); };
  const t = p.tabEl = el('div', { className: 'ptab', role: 'tab' },
    el('span', { className: 'ptab-icon', ariaHidden: 'true' }), el('span', { className: 'ptab-title' }), close);
  updatePaneTab(p);
  t.onpointerdown = e => startPaneDrag(e, tab, p, t);
  t.onauxclick = e => { if (e.button === 1) closePane(p); };
  t.ondblclick = () => renamePane(p);
  t.oncontextmenu = e => { e.preventDefault(); showPaneMenu(p, { left: e.clientX, top: e.clientY, bottom: e.clientY }); };
  return t;
}

function updatePaneTab(p) {
  const t = p.tabEl;
  if (!t) return;
  const icon = t.querySelector('.ptab-icon');
  if (p.isAgent) icon.replaceChildren(iconEl(paneLook(p), Date.now() - p.lastWork < 2000 ? 'working' : ''));
  else icon.textContent = PANE_ICONS[p.kind];
  const title = t.querySelector('.ptab-title');
  if (title) title.textContent = p.label();
  t.title = [p.name(), p.cwd, p.title].filter(Boolean).join('\n');
  const close = t.querySelector('.ptab-close');
  close.title = `Close ${p.label()} (Ctrl+Shift+W)`;
  close.ariaLabel = `Close ${p.label()}`;
}

function renamePane(p) {
  const span = p.tabEl?.querySelector('.ptab-title');
  if (!span) return;
  let finished = false;
  const input = el('input', { className: 'ptab-input', value: p.label(), ariaLabel: 'Pane name' });
  const done = save => {
    if (finished) return;
    finished = true;
    if (save) p.customTitle = input.value.trim() || null;
    input.replaceWith(span);
    updatePaneTab(p);
    scheduleSave();
    focusPane(p.tab, p);
  };
  input.onkeydown = e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); };
  input.onblur = () => done(true);
  input.onpointerdown = e => e.stopPropagation();
  span.replaceWith(input);
  input.select();
  input.focus();
}

function gutter(node, index, box, done = scheduleSave) {
  const g = el('div', { className: `gutter gutter-${node.dir}`, role: 'separator', ariaLabel: 'Resize panes' });
  g.onpointerdown = e => {
    g.setPointerCapture(e.pointerId);
    const r = box.getBoundingClientRect();
    const total = node.dir === 'row' ? r.width : r.height;
    let last = node.dir === 'row' ? e.clientX : e.clientY;
    g.onpointermove = ev => {
      const pos = node.dir === 'row' ? ev.clientX : ev.clientY;
      Layout.resize(node, index, (pos - last) / total);
      last = pos;
      [...box.children].filter(c => !c.classList.contains('gutter')).forEach((c, i) => { c.style.flex = `${node.sizes[i]} 1 0`; });
    };
    g.onpointerup = () => { g.onpointermove = g.onpointerup = null; done(); };
  };
  return g;
}

function showAddMenu(tab, g, anchor) {
  const add = spec => addPane(tab, spec, { group: g });
  const seg = el('div', { className: 'menu-seg', role: 'radiogroup', ariaLabel: 'Open new panes as' },
    ...[['tab', 'Tab'], ['right', 'Split right'], ['down', 'Split down']].map(([v, l]) => {
      const b = el('button', { textContent: l, className: S.newPanePlacement === v ? 'on' : '', role: 'radio' });
      b.setAttribute('aria-checked', String(S.newPanePlacement === v));
      b.onclick = e => {
        e.stopPropagation();
        set('newPanePlacement', v);
        for (const x of seg.children) { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', String(x === b)); }
      };
      return b;
    }));
  showMenu(anchor, [
    'Terminal',
    ...S.profiles.map(p => ({ label: p.name + (p.name === S.defaultProfile ? ' (default)' : ''), run: () => add({ kind: 'shell', profile: p.name }) })),
    '-', 'Agent',
    tab.type === 'sandbox' && { label: `Sandbox: ${tab.sandbox.name}`, run: () => add({ kind: 'sandbox', sandbox: tab.sandbox }) },
    ...S.agents.map(a => ({ icon: iconEl(agentLook(a.id)), label: a.name + (a.id === S.defaultAgent ? ' (default)' : ''), run: () => add({ kind: 'agent', agentId: a.id }) })),
    '-', 'Open new panes as', seg,
  ]);
}

// Agent CLIs (not sandboxes, which stay in their workspace) can restart in any folder the tab's terminals are in.
function reopenAgentIn(p, dir) {
  p.cwd = dir;
  p.resume = false;
  p.tab.info.model = p.tab.info.modelLabel = null;
  p.restart();
  updatePaneTab(p);
  refreshInfo([p.tab]);
  scheduleSave();
}

function showPaneMenu(p, at) {
  const multi = tabPanes(p.tab).length > 1;
  const dirs = p.kind === 'agent' ? [...new Set(tabPanes(p.tab).filter(x => x.kind === 'shell').map(x => x.cwd))] : [];
  showMenu(at, [
    ...(dirs.length ? ['Reopen agent in', ...dirs.map(d => ({ label: `${d === p.cwd ? '✓' : '\u2003'} ${shortPath(d)}`, run: () => reopenAgentIn(p, d) })), '-'] : []),
    { label: 'Rename', run: () => renamePane(p) },
    { label: 'Restart', run: () => p.restart() },
    multi && { label: 'Split right', run: () => dropPane(p.tab, p, { kind: 'group', group: Layout.groupOf(p.tab.root, p), side: 'right' }) },
    multi && { label: 'Split down', run: () => dropPane(p.tab, p, { kind: 'group', group: Layout.groupOf(p.tab.root, p), side: 'bottom' }) },
    multi && { label: 'Move to new tab', run: () => movePaneToTab(p, null) },
    '-',
    { label: 'Close', run: () => closePane(p) },
  ]);
}

// ---------------------------------------------------------------- dragging panes (Windows-style snap)
// Drag a pane's tab onto: a pane's edge (split there), its middle (join as a tab), a tab strip (insert),
// a sidebar tab (move to that tab) or empty sidebar space (new tab). A highlight previews the result.
function startPaneDrag(down, tab, pane, src) {
  if (down.button !== 0) return;
  focusPane(tab, pane);
  down.preventDefault();
  src.setPointerCapture(down.pointerId);
  let dragging = false, target = null;
  const ghost = el('div', { className: 'drag-ghost', textContent: `${PANE_ICONS[pane.kind]}  ${pane.label()}` });
  const move = ev => {
    if (!dragging) {
      if (Math.hypot(ev.clientX - down.clientX, ev.clientY - down.clientY) < 6) return;
      dragging = true;
      document.body.append(ghost);
      document.body.classList.add('dragging-pane');
      src.classList.add('drag-source');
    }
    ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 10}px)`;
    target = dropTarget(tab, pane, ev.clientX, ev.clientY);
    showSnap(target);
  };
  const end = drop => {
    src.removeEventListener('pointermove', move);
    src.removeEventListener('pointerup', up);
    src.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', esc, true);
    ghost.remove();
    showSnap(null);
    src.classList.remove('drag-source');
    document.body.classList.remove('dragging-pane');
    if (drop && dragging && target) dropPane(tab, pane, target);
  };
  const up = () => end(true);
  const cancel = () => end(false);
  const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); end(false); } };
  src.addEventListener('pointermove', move);
  src.addEventListener('pointerup', up);
  src.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', esc, true);
}

function dropTarget(tab, pane, x, y) {
  const at = document.elementFromPoint(x, y);
  if (!at) return null;
  const alone = tabPanes(tab).length === 1;
  const sideItem = at.closest('#tabs .tab');
  if (sideItem) {
    const dest = tabs[[...$('#tabs').children].indexOf(sideItem)];
    if (!dest || dest === tab || dest.type === 'sbx') return null;
    return { kind: 'tab', tab: dest, rect: sideItem.getBoundingClientRect(), label: `Move to ${tabTitle(dest)}` };
  }
  if (at.closest('#tabbar')) {
    return alone ? null : { kind: 'newtab', rect: $('#tabs').getBoundingClientRect(), label: 'Open in a new tab' };
  }
  const box = at.closest('.group');
  const g = box && tab.view.contains(box) && Layout.groups(tab.root).find(n => n.box === box);
  if (!g) return null;
  const own = Layout.groupOf(tab.root, pane);
  const strip = at.closest('.pane-strip');
  if (strip) {
    const tabEls = [...strip.querySelectorAll('.ptab')];
    let index = tabEls.findIndex(t => { const r = t.getBoundingClientRect(); return x < r.left + r.width / 2; });
    if (index < 0) index = tabEls.length;
    const ref = tabEls[index] || tabEls.at(-1);
    const rr = ref.getBoundingClientRect();
    return { kind: 'group', group: g, side: 'center', index, rect: g.body.getBoundingClientRect(),
      marker: { x: tabEls[index] ? rr.left - 2 : rr.right + 1, top: rr.top, height: rr.height }, label: g === own ? 'Move here' : 'Add as a tab' };
  }
  const rect = g.body.getBoundingClientRect();
  const side = Layout.dropZone(rect, x, y, clamp(S.snapEdge, 10, 45) / 100);
  if (g === own && (side === 'center' || g.panes.length === 1)) return null; // would land where it already is
  const labels = { left: 'Split left', right: 'Split right', top: 'Split up', bottom: 'Split down', center: 'Add as a tab' };
  return { kind: 'group', group: g, side, rect: Layout.zoneRect(rect, side), label: labels[side] };
}

function showSnap(target) {
  const box = $('#snap-overlay'), marker = $('#snap-marker');
  marker.hidden = !target?.marker;
  if (target?.marker) Object.assign(marker.style, { left: `${target.marker.x}px`, top: `${target.marker.top}px`, height: `${target.marker.height}px` });
  if (!target || !S.snapPreview) { box.hidden = true; return; }
  const wasHidden = box.hidden;
  box.classList.toggle('animate', S.paneAnimations && !wasHidden); // don't animate in from the last spot
  const r = target.rect;
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  box.firstElementChild.textContent = target.label;
  box.hidden = false;
}

function dropPane(tab, pane, target) {
  if (target.kind === 'tab') return movePaneToTab(pane, target.tab);
  if (target.kind === 'newtab') return movePaneToTab(pane, null);
  tab.root = Layout.movePane(tab.root, pane, target.group, target.side, target.index);
  tab.zoom = null;
  renderLayout(tab);
  focusPane(tab, pane);
}

// ---------------------------------------------------------------- keyboard pane commands
function resizePane(dir) {
  const tab = active;
  let node = tab && Layout.groupOf(tab.root, focusedPane(tab));
  if (!node) return false;
  const want = dir === 'left' || dir === 'right' ? 'row' : 'col';
  for (let at = Layout.parentOf(tab.root, node); at; node = at.parent, at = Layout.parentOf(tab.root, node)) {
    if (at.parent.dir !== want) continue;
    const grow = dir === 'right' || dir === 'down' ? 0.05 : -0.05;
    Layout.resize(at.parent, at.index < at.parent.children.length - 1 ? at.index : at.index - 1, grow);
    renderLayout(tab);
    return true;
  }
  return false;
}

// Focus the nearest pane group in a direction. Returns false (key goes to the terminal) when there is none.
function moveFocus(dir) {
  const tab = active, cur = focusedPane(tab);
  const own = cur && Layout.groupOf(tab.root, cur);
  if (!own?.box?.isConnected) return false;
  const from = own.box.getBoundingClientRect();
  const cx = from.left + from.width / 2, cy = from.top + from.height / 2;
  let best = null, bestDist = Infinity;
  for (const g of Layout.groups(tab.root)) {
    if (g === own || !g.box?.isConnected) continue;
    const r = g.box.getBoundingClientRect();
    const inDir = { left: r.right <= from.left + 2, right: r.left >= from.right - 2, up: r.bottom <= from.top + 2, down: r.top >= from.bottom - 2 }[dir];
    const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy);
    if (inDir && d < bestDist) { best = g; bestDist = d; }
  }
  if (!best) return false;
  focusPane(tab, best.panes[best.active]);
  return true;
}

function toggleSplitOrientation() {
  const tab = active;
  const at = tab && Layout.parentOf(tab.root, Layout.groupOf(tab.root, focusedPane(tab)));
  if (!at) return;
  at.parent.dir = at.parent.dir === 'row' ? 'col' : 'row';
  tab.root = Layout.normalize(tab.root);
  renderLayout(tab);
}

function togglePaneZoom() {
  const tab = active;
  if (!tab || Layout.groups(tab.root).length < 2) return;
  tab.zoom = tab.zoom ? null : Layout.groupOf(tab.root, focusedPane(tab));
  renderLayout(tab);
  focusPane(tab, focusedPane(tab));
}

function setFontDelta(d) {
  fontDelta = clamp(d, 6 - S.fontSize, 72 - S.fontSize);
  for (const t of tabs) for (const p of tabPanes(t)) p.applySettings();
  renderZoom();
}

// Bottom bar: terminal zoom relative to the font size in settings, with a reset when it differs.
const ZOOM_LEVELS = [50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200];
function renderZoom() {
  const size = clamp(S.fontSize + fontDelta, 6, 72);
  const pct = Math.round(size / S.fontSize * 100);
  // Ctrl+scroll moves 1px at a time, which can land between presets: list that level too.
  const levels = [...new Set([...ZOOM_LEVELS, pct])].sort((a, b) => a - b);
  $('#zoom-level').replaceChildren(...levels.map(l => el('option', { value: l, textContent: `${l}%`, selected: l === pct })));
  $('#zoom-level').title = `Font ${size}px (default ${S.fontSize}px, set in Settings → Appearance). Ctrl+scroll also zooms.`;
  $('#zoom-reset').hidden = fontDelta === 0;
}
$('#zoom-level').onchange = e => setFontDelta(Math.round(S.fontSize * e.target.value / 100) - S.fontSize);
$('#zoom-reset').onclick = () => setFontDelta(0);


// ---------------------------------------------------------------- session (reopen tabs on launch)
// The sbx tab isn't saved: it comes back from the sandboxEnabled setting. Each tab saves its whole
// pane layout (splits, groups, which pane is active, sizes); older sessions without one still load.
function sessionState() {
  const saved = tabs.filter(t => t.type !== 'sbx' && t.root);
  return {
    active: active?.type === 'sbx' ? 'sbx' : saved.indexOf(active),
    tabs: saved.map(t => ({
      type: t.type, cwd: t.cwd, sandbox: t.sandbox, title: t.title, color: t.color,
      layout: Layout.serialize(t.root, paneJson),
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
  await active?.starting;
}

// Starts the terminals of tabs not shown yet, one tab per frame so the window stays responsive.
async function startBackgroundTabs() {
  for (const t of [...tabs]) {
    if (t === active || !tabs.includes(t)) continue;
    t.view.classList.add('active'); // xterm must measure its cell size while visible; removed before the next paint
    startPanes(t);
    t.view.classList.toggle('active', t === active);
    await new Promise(requestAnimationFrame);
  }
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
  return el('div', { className: 'meta git' }, ...parts);
}

// What runs in a tab, in one line: the agent (and its model) first, then the terminals.
function panesLine(tab) {
  const all = tabPanes(tab);
  const agents = all.filter(p => p.isAgent), shells = all.filter(p => p.kind === 'shell');
  const lead = primaryAgent(tab) || agents[0];
  const parts = [];
  if (tab.type === 'sandbox') parts.push(`⧉ ${[tab.sandbox.agent || 'sandbox', tab.info.status].filter(Boolean).join(' · ')}`);
  else if (lead) parts.push(`${[lead.name(), tab.info.modelLabel].filter(Boolean).join(' · ')}${agents.length > 1 ? ` +${agents.length - 1}` : ''}`);
  if (shells.length) parts.push(shells.length === 1 ? `›_ ${shells[0].profile}` : `›_ ${shells.length} terminals`);
  return parts.join('  ');
}

function tabMetas(tab) {
  const m = S.tabMetadata;
  if (tab.type === 'sbx') {
    const list = tab.info.sandboxes;
    return [el('div', {
      className: 'meta', textContent: list ? `Docker Sandboxes · ${list.filter(s => s.status === 'running').length} running / ${list.length}` : 'Docker Sandboxes',
    })];
  }
  const line = m.model && panesLine(tab);
  return [
    m.directory && el('div', { className: 'meta dir', textContent: shortPath(tab.cwd) }),
    m.git && tab.info.git?.branch && gitLine(tab.info.git),
    line && el('div', { className: 'meta model', textContent: line }),
  ];
}

function tabItem(tab) {
  const isSbx = tab.type === 'sbx';
  const item = el('div', {
    className: ['tab', `tab-${tab.type}`, tab === active && 'active', tab.attention && 'attention', isWorking(tab) && 'working'].filter(Boolean).join(' '),
    role: 'tab', tabIndex: 0, draggable: !isSbx,
  });
  item.setAttribute('aria-selected', String(tab === active));
  const close = el('button', { className: 'tab-close', textContent: '×', title: 'Close tab', ariaLabel: `Close ${tabTitle(tab)}` });
  close.onclick = e => { e.stopPropagation(); closeTab(tab); };
  const title = el('span', { className: 'tab-title', textContent: tabTitle(tab) });
  title.ondblclick = () => startRename(tab, title);
  const state = tabState(tab);
  const lead = !isSbx && (primaryAgent(tab) || tabPanes(tab).find(p => p.isAgent));
  const look = lead && paneLook(lead);
  if (look?.color) item.style.setProperty('--ai-color', look.color); // the working sweep takes the agent's color
  const marker = isSbx ? el('span', { className: 'sbx-icon', textContent: '⬢', ariaHidden: 'true' })
    : look ? iconEl(look, state[0] || 'idle', state[1])
      : el('span', { className: `dot ${state[0]}`, role: 'img', ariaLabel: state[1] });
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

const tabState = tab => (isWorking(tab) ? ['working', 'Agent is working']
  : tab.attention ? ['attention', 'Needs attention']
    : tab.done ? ['done', 'Agent finished']
      : ['', 'Idle']);

function renderTabs() {
  if (renaming || !S) return;
  $('#tabs').replaceChildren(...tabs.map(tabItem));
  if (tipTab) showTip(tipTab);
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

// ---------------------------------------------------------------- tab hover card
// Hovering (or keyboard-focusing) a tab shows what's going on in it: folder, git, and every pane's state.
let hoverTab = null, tipTab = null, tipTimer = 0;

const ago = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
};

function paneState(p, now) {
  if (p.exited) return ['exited', 'Exited'];
  if (!p.ptyId) return ['', p.term ? 'Starting' : 'Starts when you open the tab'];
  if (p.isAgent) return now - p.lastWork < 2000 ? ['working', 'Working'] : ['', 'Idle'];
  return ['', '']; // a running terminal needs no label
}

function tipContent(tab) {
  const now = Date.now();
  const [cls, label] = tabState(tab);
  const lead = tab.type !== 'sbx' && (primaryAgent(tab) || tabPanes(tab).find(p => p.isAgent));
  const head = el('div', { className: 'tip-head' },
    lead && iconEl(paneLook(lead), cls || 'idle'),
    el('strong', { textContent: tabTitle(tab) }),
    el('span', { className: `tip-state ${cls}`, textContent: cls === 'working' && tab.busySince ? `${label} · ${ago(now - tab.busySince)}` : label }));
  if (tab.type === 'sbx') {
    const list = tab.info.sandboxes || [];
    return [head, el('div', { className: 'tip-sub', textContent: 'Docker Sandboxes dashboard (sbx)' }),
      ...list.map(sb => el('div', { className: 'tip-row' }, el('span', { textContent: '⧉' }), el('span', { textContent: `${sb.name} · ${sb.agent || ''} · ${sb.status}` })))];
  }
  const g = tab.info.git;
  const gitText = g?.branch && [`Git: ${g.branch}`, g.ahead && `↑${g.ahead}`, g.behind && `↓${g.behind}`, g.changes ? `${g.changes} changed` : 'clean'].filter(Boolean).join('  ');
  const all = tabPanes(tab);
  return [
    head,
    el('div', { className: 'tip-sub', textContent: tab.cwd }),
    gitText && el('div', { className: 'tip-sub', textContent: gitText }),
    el('div', { className: 'tip-label', textContent: `${all.length} pane${all.length === 1 ? '' : 's'}` }),
    ...all.map(p => {
      const [pc, pl] = paneState(p, now);
      const model = p === primaryAgent(tab) && tab.info.modelLabel;
      // Agents put their current task in the terminal title (Claude Code does); shells, their folder.
      // (A title that's just the launching shell's path, e.g. cmd.exe, says nothing.)
      const detail = p.isAgent ? !/\.exe$/i.test(p.title || '') && p.title : p.cwd !== tab.cwd && shortPath(p.cwd);
      return el('div', { className: 'tip-row' + (p === tab.focused ? ' focused' : '') },
        p.isAgent ? el('span', { className: 'tip-icon' }, iconEl(paneLook(p), pc))
          : el('span', { className: `tip-icon ${pc}`, textContent: PANE_ICONS[p.kind], ariaHidden: 'true' }),
        el('span', { className: 'tip-pane' },
          el('span', { textContent: [p.label(), model].filter(Boolean).join(' · ') }),
          detail && el('small', { textContent: detail })),
        pl && el('span', { className: `tip-pstate ${pc}`, textContent: pl }));
    }),
    tab.lastAgentOutput > 0 && el('div', { className: 'tip-foot', textContent: `Last agent output ${ago(now - tab.lastAgentOutput)} ago` }),
  ];
}

function showTip(tab) {
  const item = $('#tabs').children[tabs.indexOf(tab)];
  const tip = $('#tab-tip');
  if (!item || !S) return hideTip();
  tipTab = tab;
  tip.replaceChildren(...tipContent(tab).filter(Boolean));
  tip.hidden = false;
  const r = item.getBoundingClientRect();
  const vertical = $('#app').classList.contains('vertical');
  const left = vertical ? r.right + 8 : r.left;
  const top = vertical ? r.top : r.bottom + 6;
  tip.style.left = `${clamp(left, 8, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${clamp(top, 8, innerHeight - tip.offsetHeight - 8)}px`;
}

function hideTip() {
  clearTimeout(tipTimer);
  tipTab = null;
  $('#tab-tip').hidden = true;
}

function hoverTabAt(target, delay) {
  const item = target?.closest?.('#tabs .tab');
  const tab = item ? tabs[[...$('#tabs').children].indexOf(item)] : null;
  if (tab === hoverTab) return;
  hoverTab = tab;
  hideTip();
  if (tab) tipTimer = setTimeout(() => showTip(tab), delay);
}
$('#tabs').addEventListener('pointerover', e => hoverTabAt(e.target, 450));
$('#tabs').addEventListener('pointerleave', () => { hoverTab = null; hideTip(); });
$('#tabs').addEventListener('focusin', e => hoverTabAt(e.target, 0));
$('#tabs').addEventListener('focusout', () => { hoverTab = null; hideTip(); });
// Clicking, dragging or renaming dismisses it until the pointer moves to another tab.
window.addEventListener('pointerdown', hideTip, true);
window.addEventListener('dragstart', hideTip, true);

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
  else if (tipTab) showTip(tipTab); // keep its timers and pane states live
  // Each agent's own tab icon pulses while that agent works.
  const now = Date.now();
  for (const p of tabPanes(active)) p.tabEl?.querySelector('.ptab-icon .agent-icon')?.classList.toggle('working', isWorking(p.tab) && now - p.lastWork < 2000);
}, 500);

async function refreshInfo(list = tabs) {
  if (!S) return;
  const sandboxes = list.some(t => t.type !== 'workspace') ? await api.sbxList().catch(() => null) : null;
  await Promise.all(list.map(async t => {
    if (t.type === 'sbx') { t.info.sandboxes = sandboxes; return; }
    if (t.type === 'sandbox') t.info.status = sandboxes?.find(s => s.name === t.sandbox.name)?.status;
    if (!(S.tabMetadata.git || S.tabMetadata.model)) return;
    try {
      const a = primaryAgent(t);
      const { git, model, modelLabel } = await api.getInfo({
        cwd: t.cwd, agentCwd: a?.cwd, agentId: a?.agentId, command: agentDef(a?.agentId)?.command, since: a?.agentStarted || 0,
      });
      Object.assign(t.info, { git, model, modelLabel });
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
  for (const p of tabPanes(tab)) updatePaneTab(p); // pane tab icons follow the tab color
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
    const b = it.icon
      ? el('button', { className: 'has-icon', role: 'menuitem' }, it.icon, el('span', { textContent: it.label }))
      : el('button', { textContent: it.label, role: 'menuitem' });
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

$('#settings-btn').onclick = () => openSettings();
$('#new-tab-menu').onclick = e => showMenu(e.currentTarget, [
  { label: `${defaultTabLabel()}  (Ctrl+Shift+T)`, run: () => newTab() },
  { label: 'Terminal only  (Ctrl+Alt+T)', run: () => newTab({ agent: '' }) },
  '-', 'Shell',
  ...S.profiles.map(p => ({ label: p.name + (p.name === S.defaultProfile ? ' (default)' : ''), run: () => newTab({ profile: p.name }) })),
  '-', 'Agent',
  ...S.agents.map(a => ({ icon: iconEl(agentLook(a.id)), label: a.name + (a.id === S.defaultAgent ? ' (default)' : ''), run: () => newTab({ agent: a.id }) })),
  '-', 'Template',
  ...S.templates.map(t => ({ label: t.name + (t.name === S.defaultTemplate ? ' (default)' : ''), run: () => newTab({ template: t.name }) })),
  { label: 'Edit templates…', run: () => openSettings('Templates') },
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
    ...S.templates.map(t => ({ name: `New tab from template: ${t.name}`, run: () => newTab({ template: t.name }) })),
    { name: 'Save tab as template', run: saveTabAsTemplate },
    ...S.profiles.map(p => ({ name: `New terminal pane: ${p.name}`, run: () => addPane(active, { kind: 'shell', profile: p.name }) })),
    ...S.agents.map(a => ({ name: `New agent pane: ${a.name}`, run: () => addPane(active, { kind: 'agent', agentId: a.id }) })),
    ...S.agents.map(a => ({ name: `Switch agent: ${a.name}`, run: () => switchAgent(a.id) })),
    ...S.schemes.map(s => ({ name: `Color scheme: ${s.name}`, run: () => set('colorScheme', s.name) })),
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
const NEW_TAB_LAYOUTS = [['right', 'Agent on the right'], ['left', 'Agent on the left'], ['bottom', 'Agent below'],
  ['top', 'Agent above'], ['tab', 'Terminal and agent as tabs']];
const schemeOptions = () => S.schemes.map(s => s.name);
function browseButton(onPick) {
  const b = el('button', { textContent: 'Browse…', type: 'button' });
  b.onclick = async e => { e.preventDefault(); const d = await api.openFolder(); if (d) onPick(d); };
  return b;
}

// What a plain new tab opens: the default template, else the default agent with a terminal.
function defaultTabLabel() {
  if (S.templates.some(t => t.name === S.defaultTemplate)) return `Template: ${S.defaultTemplate}`;
  const agent = agentDef(S.defaultAgent)?.name;
  return agent ? `${agent} + terminal` : 'Terminal';
}

// ---------------------------------------------------------------- new-tab templates
// A template is { name, layout }: a pane tree in Layout.serialize form whose panes are
// { kind: 'shell', profile } or { kind: 'agent', agentId } (plus an optional title).
const paneChoices = () => [...S.profiles.map(p => [`shell:${p.name}`, `›_  ${p.name}`]), ...S.agents.map(a => [`agent:${a.id}`, `✦  ${a.name}`])];
const choiceOf = p => (p.kind === 'agent' ? `agent:${p.agentId}` : `shell:${p.profile}`);
function specOf(choice) {
  const [kind, ...rest] = choice.split(':');
  return kind === 'agent' ? { kind, agentId: rest.join(':') } : { kind: 'shell', profile: rest.join(':') };
}
const templatePane = p => ({
  ...(p.kind === 'agent' ? { kind: 'agent', agentId: p.agentId } : { kind: 'shell', profile: p.kind === 'shell' ? p.profile : S.defaultProfile }),
  ...(p.customTitle && { title: p.customTitle }),
});

function uniqueTemplateName(base, except) {
  const taken = n => S.templates.some(t => t.name === n && t !== except);
  let name = base, i = 2;
  while (taken(name)) name = `${base} ${i++}`;
  return name;
}

function addTemplate(layout, base = 'New template') {
  set('templates', [...S.templates, { name: uniqueTemplateName(base), layout }]);
}

function saveTabAsTemplate() {
  if (active?.type !== 'workspace') return notify('Only folder tabs can be saved as templates');
  addTemplate(Layout.serialize(active.root, templatePane), tabTitle(active));
  openSettings('Templates');
}

function templatesSection() {
  const agentId = S.defaultAgent || S.agents[0]?.id;
  const starter = agentId
    ? { split: 'row', sizes: [0.5, 0.5], children: [{ panes: [{ kind: 'agent', agentId }] }, { panes: [{ kind: 'shell', profile: S.defaultProfile }] }] }
    : { panes: [{ kind: 'shell', profile: S.defaultProfile }] };
  const newBtn = el('button', { textContent: '+ New template', type: 'button', className: 'secondary' });
  newBtn.onclick = () => addTemplate(starter);
  const saveBtn = el('button', { textContent: 'Save current tab as template', type: 'button', className: 'secondary', disabled: active?.type !== 'workspace' });
  saveBtn.onclick = saveTabAsTemplate;
  return [
    el('p', { className: 'note', textContent: 'A template sets which terminals and agents a new tab opens with, and where they sit. Split a box to add a pane beside or below it, add a tab to stack panes, and drag the dividers to size them. Or arrange a tab the way you like and save it here.' }),
    field('New tabs open with', select(S.defaultTemplate, [['', 'Terminal + default agent (General → New tab layout)'], ...S.templates.map(t => t.name)], v => set('defaultTemplate', v)),
      'Used by the bottom bar button, Ctrl+Shift+T and new windows. Every template is also in the ▾ menu and the command palette.'),
    el('div', { className: 'row tpl-actions' }, newBtn, saveBtn),
    ...S.templates.map(templateCard),
  ];
}

function templateCard(tpl) {
  let root = Layout.deserialize(tpl.layout, j => ({ ...j }));
  const commit = (patch = {}) => {
    const next = { ...tpl, layout: Layout.serialize(root, p => p), ...patch };
    const update = { templates: S.templates.map(t => (t === tpl ? next : t)) };
    if (patch.name && S.defaultTemplate === tpl.name) update.defaultTemplate = patch.name;
    api.updateSettings(update);
  };
  const button = (text, title, onclick, cls = '') => Object.assign(el('button', { textContent: text, title, ariaLabel: title, type: 'button', className: cls }), { onclick });
  const fresh = () => ({ kind: 'shell', profile: S.defaultProfile });
  const total = Layout.panes(root).length;

  const slot = p => {
    const pick = select(choiceOf(p), paneChoices(), v => {
      for (const k of ['kind', 'profile', 'agentId']) delete p[k];
      Object.assign(p, specOf(v));
      commit();
    });
    pick.ariaLabel = 'Pane runs';
    return el('div', { className: 'tpl-slot' },
      p.kind === 'agent' ? iconEl(agentLook(p.agentId)) : el('span', { className: 'tpl-shell', textContent: '›_', ariaHidden: 'true' }), pick,
      total > 1 && button('×', 'Remove this pane', () => { root = Layout.removePane(root, p); commit(); }, 'tpl-x'));
  };
  const build = node => {
    if (node.kind === 'group') {
      return el('div', { className: 'tpl-group' },
        node.panes.length > 1 && el('div', { className: 'tpl-stacked', textContent: `${node.panes.length} panes as tabs` }),
        ...node.panes.map(slot),
        el('div', { className: 'tpl-tools' },
          button('Split →', 'Add a pane to the right', () => { root = Layout.splitAt(root, node, Layout.group([fresh()]), 'right'); commit(); }),
          button('Split ↓', 'Add a pane below', () => { root = Layout.splitAt(root, node, Layout.group([fresh()]), 'bottom'); commit(); }),
          button('+ Tab', 'Stack another pane here as a tab', () => { Layout.addToGroup(node, fresh()); commit(); })));
    }
    const box = el('div', { className: `tpl-split split-${node.dir}` });
    node.children.forEach((c, i) => {
      if (i) box.append(gutter(node, i - 1, box, () => commit()));
      const child = build(c);
      child.style.flex = `${node.sizes[i]} 1 0`;
      box.append(child);
    });
    return box;
  };

  const name = el('input', { type: 'text', value: tpl.name, className: 'tpl-name', ariaLabel: 'Template name' });
  name.onchange = () => {
    const v = name.value.trim();
    if (!v || v === tpl.name) { name.value = tpl.name; return; }
    commit({ name: uniqueTemplateName(v, tpl) });
  };
  const isDefault = S.defaultTemplate === tpl.name;
  return el('div', { className: 'tpl-card' + (isDefault ? ' default' : '') },
    el('div', { className: 'tpl-head' }, name,
      isDefault ? el('span', { className: 'tpl-badge', textContent: 'Default for new tabs' })
        : button('Use for new tabs', 'Open new tabs with this template', () => set('defaultTemplate', tpl.name), 'link'),
      el('span', { className: 'spacer' }),
      button('Open', 'Open a new tab from this template', () => { closeSettings(); newTab({ template: tpl.name }); }, 'secondary'),
      button('Delete', 'Delete this template', () => api.updateSettings({
        templates: S.templates.filter(t => t !== tpl), ...(isDefault && { defaultTemplate: '' }),
      }), 'danger')),
    el('div', { className: 'tpl-preview' }, build(root)));
}

// ---------------------------------------------------------------- agent icon picker (Settings → Agents)
const ICON_COLORS = ['#D97757', '#F5A623', '#E5C07B', '#3FB950', '#10A37F', '#00B7C3', '#4C8DF6', '#8B5CF6', '#E3008C', '#E74856', '#9D9D9D'];

function iconButton(a) {
  const look = agentLook(a.id);
  const b = el('button', { className: 'icon-pick', type: 'button', title: `Change ${a.name}'s icon`, ariaLabel: `Change ${a.name}'s icon` }, iconEl(look, 'working'));
  if (look.color) b.style.setProperty('--ai-color', look.color);
  b.onclick = () => showIconPicker(a, b);
  return b;
}

// A grid of every icon (all animating, so you see how each one works) plus colors and a state preview.
// Picks save immediately; undefined drops the key from settings.json, which restores the built-in default.
function showIconPicker(a, anchor) {
  const look = agentLook(a.id);
  const box = el('div', { className: 'icon-picker' });
  const paint = c => { if (c) box.style.setProperty('--ai-color', c); else box.style.removeProperty('--ai-color'); };
  paint(look.color);
  const save = patch => set('agents', [{ id: a.id, ...patch }]);
  const grid = el('div', { className: 'icon-grid', role: 'radiogroup', ariaLabel: `Icon for ${a.name}` },
    ...AgentIcons.names.map(name => {
      const b = el('button', { className: 'icon-choice' + (name === look.icon ? ' selected' : ''), type: 'button', role: 'radio', title: AgentIcons.label(name), ariaLabel: AgentIcons.label(name) },
        iconEl({ icon: name }, 'working'));
      b.setAttribute('aria-checked', String(name === look.icon));
      b.onclick = () => {
        for (const x of grid.children) { x.classList.toggle('selected', x === b); x.setAttribute('aria-checked', String(x === b)); }
        states.replaceChildren(...stateSamples(name));
        save({ icon: name });
      };
      return b;
    }));
  const colors = el('div', { className: 'icon-colors', role: 'radiogroup', ariaLabel: 'Icon color' },
    ...ICON_COLORS.map(c => {
      const b = el('button', { className: 'swatch' + (c.toLowerCase() === look.color?.toLowerCase() ? ' selected' : ''), type: 'button', title: c, ariaLabel: `Color ${c}` });
      b.style.background = c;
      b.onclick = () => { for (const x of colors.children) x.classList.toggle('selected', x === b); paint(c); save({ iconColor: c }); };
      return b;
    }));
  const picker = el('input', { type: 'color', value: look.color || '#4C8DF6', ariaLabel: 'Custom icon color' });
  picker.oninput = () => paint(picker.value);              // live preview while dragging
  picker.onchange = () => save({ iconColor: picker.value }); // save once the color is chosen
  const custom = el('label', { className: 'menu-custom' }, 'Custom color…', picker);
  const stateSamples = name => [['idle', 'Idle'], ['working', 'Working'], ['attention', 'Needs you'], ['done', 'Finished']]
    .map(([st, l]) => el('span', {}, iconEl({ icon: name }, st), l));
  const states = el('div', { className: 'icon-states' }, ...stateSamples(look.icon));
  box.append(grid, el('div', { className: 'menu-header', textContent: 'Color' }), colors, custom,
    el('div', { className: 'menu-header', textContent: 'Preview' }), states);
  showMenu(anchor, [
    `${a.name}: icon`, box, '-',
    { label: 'Reset to default icon and color', run: () => save({ icon: undefined, iconColor: undefined }) },
  ]);
}

// ---------------------------------------------------------------- settings UI
let settingsSection = 'General';

function openSettings(section) {
  if (section) settingsSection = section;
  hideTip();
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
    field('New tab layout', select(S.agentPanePosition, NEW_TAB_LAYOUTS, v => set('agentPanePosition', v)),
      'How the terminal and agent are arranged in a new tab, unless a template is set (Settings → Templates). Rearrange any tab by dragging its pane tabs.'),
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
    field('Version', el('span', { textContent: VERSION })),
    field('Uninstall', Object.assign(el('button', { textContent: 'Uninstall Agent Terminal…', type: 'button', className: 'danger', disabled: !PACKAGED }),
      { onclick: e => { e.preventDefault(); api.uninstall(); } }),
    PACKAGED
      ? 'Removes the app, its shortcuts and its Apps & features entry. You can also delete your settings and saved tabs. Your projects and agent CLIs are not touched.'
      : 'Only for installed copies. You\'re running from source (npm start).'),
  ],
  Tabs: () => [
    field('Tab layout', select(S.tabLayout, [['vertical', 'Vertical (sidebar)'], ['horizontal', 'Horizontal (top)']], v => set('tabLayout', v))),
    field('Sidebar width (px)', input(S.sidebarWidth, v => set('sidebarWidth', clamp(v, 140, 600)), 'number')),
    field('Show sidebar', checkbox(S.sidebarVisible, v => set('sidebarVisible', v)), 'Toggle with Ctrl+Shift+S.'),
    el('h3', { textContent: 'Tab details' }),
    field('Directory', checkbox(S.tabMetadata.directory, v => set('tabMetadata', { directory: v }))),
    field('Git branch and status', checkbox(S.tabMetadata.git, v => set('tabMetadata', { git: v }))),
    field('What runs in the tab', checkbox(S.tabMetadata.model, v => set('tabMetadata', { model: v })),
      'The agent and its model, then the terminals. Claude Code\'s model is read live from its session; other agents\' from --model or their config file.'),
    field('Agent activity indicator', checkbox(S.tabMetadata.activity, v => set('tabMetadata', { activity: v })),
      'Animated while an agent works, orange when it needs attention, green when it finished in the background. Hover a tab for details.'),
  ],
  Panes: () => [
    el('p', { className: 'note', textContent: 'Each tab can hold any number of terminals and agents. Drag a pane\'s tab onto the edge of another pane to split, onto its middle or its tab strip to stack it as a tab, onto a tab in the sidebar to move it there, or onto empty sidebar space to give it its own tab.' }),
    field('New panes open as', select(S.newPanePlacement, [['tab', 'A tab in the same group'], ['right', 'A split to the right'], ['down', 'A split below']], v => set('newPanePlacement', v)),
      'For the + button on each tab strip and New terminal pane (Ctrl+Shift+E).'),
    field('Snap preview while dragging', toggle(S.snapPreview, v => set('snapPreview', v)), 'Highlights where the pane will land.'),
    field('Animate the preview', toggle(S.paneAnimations, v => set('paneAnimations', v))),
    field('Edge snap area (%)', input(S.snapEdge, v => set('snapEdge', clamp(v, 10, 45)), 'number'),
      'How far into a pane counts as its edge (splits). Closer to the middle stacks the pane as a tab.'),
    field('Close buttons on pane tabs', select(S.paneCloseButton, [['always', 'Always'], ['hover', 'Active tab and on hover']], v => set('paneCloseButton', v))),
  ],
  Templates: templatesSection,
  Appearance: () => [
    field('Color scheme', select(S.colorScheme, schemeOptions(), v => set('colorScheme', v)),
      'Every terminal and the app itself. A light scheme gives a light app. Also in the palette: Color scheme: …'),
    swatches(S.colorScheme),
    field('Animate agent icons', toggle(S.iconAnimations, v => set('iconAnimations', v)),
      'Each agent\'s icon moves in its own way while the agent works. Off: icons still glow, without motion. Pick icons in Settings → Agents.'),
    field('Font face', input(S.fontFace, v => set('fontFace', v))),
    field('Font size', input(S.fontSize, v => set('fontSize', clamp(v, 6, 72)), 'number'), 'Ctrl+scroll or Ctrl+= / Ctrl+- changes it temporarily.'),
    field('Cursor shape', select(S.cursorShape, ['bar', 'block', 'underline'], v => set('cursorShape', v))),
    field('Cursor blink', checkbox(S.cursorBlink, v => set('cursorBlink', v))),
    field('History size (lines)', input(S.historySize, v => set('historySize', Math.max(0, v)), 'number')),
  ],
  Profiles: () => [
    el('p', { className: 'note', textContent: 'Shells detected on this machine. Add or hide profiles in settings.json.' }),
    el('table', { className: 'list' },
      el('tr', {}, el('th', { textContent: 'Name' }), el('th', { textContent: 'Command' })),
      ...S.profiles.map(p => el('tr', {},
        el('td', { textContent: p.name }),
        el('td', { className: 'muted', textContent: [p.commandline, ...(p.args || [])].join(' ') })))),
  ],
  Agents: () => [
    el('p', { className: 'note', textContent: 'The agent pane runs this command in your shell, exactly as if you typed it. Add flags such as --model or --continue here. Click an icon to give the agent its own look and color; it animates in the sidebar and on its pane while the agent works.' }),
    el('table', { className: 'list' },
      el('tr', {}, el('th', { textContent: 'Icon' }), el('th', { textContent: 'Agent' }), el('th', { textContent: 'Command' })),
      ...S.agents.map(a => el('tr', {},
        el('td', {}, iconButton(a)),
        el('td', { textContent: a.name }),
        el('td', {}, Object.assign(input(a.command, v => v.trim() && set('agents', [{ id: a.id, command: v.trim() }])), { className: 'command' }))))),
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
      tabLayout: S.tabLayout, agentPanePosition: S.agentPanePosition, colorScheme: S.colorScheme,
      tabMetadata: { ...S.tabMetadata }, sandboxEnabled: S.sandboxEnabled && detect.sbx,
    };
    let step = 0;
    const radio = (group, value, current, label, sub, onPick, disabled, icon) => {
      const r = el('input', { type: 'radio', name: group, value, checked: value === current, disabled });
      r.onchange = () => onPick(value);
      return el('label', { className: 'choice' + (disabled ? ' disabled' : '') }, r,
        el('span', {}, el('strong', {}, icon || null, label), sub && el('small', { textContent: sub })));
    };
    const steps = [
      ['Choose your default agent', 'Each tab runs this agent CLI next to your shell, exactly as it looks in a normal terminal. You can switch per tab later.', () => [
        el('div', { className: 'choices' },
          ...S.agents.map(a => radio('agent', a.id, d.defaultAgent, a.name,
            installed(a.id) ? `Installed · runs "${a.command}"` : `Not found on PATH ("${a.command}")`, v => { d.defaultAgent = v; }, false,
            iconEl(agentLook(a.id), 'working'))),
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
        field('New tab layout', select(d.agentPanePosition, NEW_TAB_LAYOUTS, v => { d.agentPanePosition = v; })),
        field('Color scheme', select(d.colorScheme, schemeOptions(), v => { d.colorScheme = v; renderStep(); })),
        swatches(d.colorScheme),
        field('Show in each tab', el('div', { className: 'checks' },
          ...[['directory', 'Directory'], ['git', 'Git branch and status'], ['model', 'What runs in the tab (agent, model, terminals)']].map(([k, l]) =>
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
// The color scheme drives the whole window: every terminal, and the app's own colors derived from it.
function luminance(hex) {
  const n = parseInt(hex.slice(1, 7), 16);
  return (0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
}
function applyTheme() {
  const s = scheme(S.colorScheme);
  const dark = luminance(s.background) < 0.5;
  const mix = pct => `color-mix(in srgb, ${s.foreground} ${pct}%, ${s.background})`;
  const root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  for (const [k, v] of Object.entries({
    '--term-bg': s.background, '--bg': mix(dark ? 6 : 4), '--bg2': mix(dark ? 10 : 2), '--fg': s.foreground,
    '--muted': mix(62), '--border': mix(dark ? 18 : 16), '--hover': `color-mix(in srgb, ${s.foreground} 9%, transparent)`,
    '--accent': (dark ? s.brightBlue : s.blue) || s.cursorColor, '--danger': (dark ? s.brightRed : s.red) || '#ff6b6b',
  })) root.style.setProperty(k, v);
}

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

// Update notice in the bottom bar (no dialogs), in the spirit of Claude Code's status-line notice.
function renderUpdateStatus(s) {
  const box = $('#update-status');
  box.hidden = !s;
  if (!s) return box.replaceChildren();
  if (s.state === 'downloading') {
    box.replaceChildren(`↓ Downloading update ${s.version}… ${s.percent || 0}%`);
    box.title = 'Downloading in the background. You can keep working.';
    return;
  }
  const restart = el('button', { className: 'update-restart', textContent: 'Restart now', title: 'Install the update and reopen. Your tabs come back.' });
  restart.onclick = () => api.installUpdate();
  box.replaceChildren(`✓ Update ${s.version} ready · installs when you quit · `, restart);
  box.title = '';
}

function apply(payload) {
  S = payload.settings;
  HOME = payload.home;
  VERSION = payload.version;
  PACKAGED = payload.packaged;
  if (payload.error) toast(payload.error);
  buildKeymap();
  applyTheme();
  $('#app').className = [S.tabLayout === 'horizontal' ? 'horizontal' : 'vertical', !S.sidebarVisible && 'sidebar-hidden'].filter(Boolean).join(' ');
  document.documentElement.style.setProperty('--sidebar-w', `${S.sidebarWidth}px`);
  document.body.dataset.closeButtons = S.paneCloseButton;
  document.body.dataset.iconAnim = S.iconAnimations ? 'on' : 'off';
  for (const t of tabs) for (const p of tabPanes(t)) p.applySettings();
  renderZoom();
  syncSbxTab();
  renderTabs();
  renderSettings();
  requestAnimationFrame(() => { for (const t of tabs) for (const p of tabPanes(t)) p.refit(); });
}

(async () => {
  apply(await api.getSettings());
  api.onSettings(apply);
  api.onSbxOpen(openSandboxTab);
  api.onUpdateStatus(renderUpdateStatus);
  renderUpdateStatus(await api.getUpdateStatus());
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
  // Current tab first, then the update check, then the remaining tabs.
  await api.checkForUpdates();
  startBackgroundTabs();
})();
