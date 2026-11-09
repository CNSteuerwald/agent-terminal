'use strict';
// Settings live in one user-editable JSON file. Effective settings = DEFAULTS + detected
// shells/agents + the user's file. Arrays of profiles/agents merge by name/id.
const fs = require('fs');
const os = require('os');
const path = require('path');
const BUILTIN_SCHEMES = require('../shared/schemes.json');

const IS_WIN = process.platform === 'win32';

// resumeArgs: appended to the command when a tab is restored after restarting the app,
// so the agent picks up its most recent conversation in that folder.
const DEFAULT_AGENTS = [
  { id: 'claude', name: 'Claude Code', command: 'claude', resumeArgs: '--continue' },
  { id: 'copilot', name: 'GitHub Copilot CLI', command: 'copilot', resumeArgs: '--continue' },
  { id: 'codex', name: 'OpenAI Codex', command: 'codex' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', resumeArgs: '--continue' },
];

// Shell integration: report the current folder at every prompt (OSC 9;9, the Windows Terminal
// convention) so the tab follows `cd`. PowerShell's `cd` doesn't change the process's directory,
// so this is the only way to know it. Wraps whatever prompt the profile set (oh-my-posh etc.).
const PS_INTEGRATION = [
  '$global:__atPrompt = $function:prompt',
  'function global:prompt {',
  '  $loc = $executionContext.SessionState.Path.CurrentLocation',
  '  $osc = if ($loc.Provider.Name -eq "FileSystem") { "$([char]27)]9;9;`"$($loc.ProviderPath)`"$([char]27)\\" } else { "" }',
  '  $osc + (& $global:__atPrompt)',
  '}',
].join('\n');

const DEFAULTS = {
  setupComplete: false, // false shows the first-run setup wizard
  restoreSession: true, // reopen the previous tabs (and resume agents) on launch
  sandboxEnabled: false, // Docker Sandboxes: pinned "sbx" tab running the sbx TUI
  sandboxCommand: 'sbx',
  defaultProfile: '',
  defaultAgent: 'claude',
  startingDirectory: '~',
  tabLayout: 'vertical',
  sidebarWidth: 260,
  sidebarVisible: true,
  tabMetadata: { directory: true, git: true, model: true, activity: true },
  agentPanePosition: 'right',
  agentPaneSize: 50,
  theme: 'dark',
  colorScheme: 'Campbell',
  // Nerd Fonts first so oh-my-posh/starship prompt glyphs render; missing fonts are skipped.
  fontFace: "'CaskaydiaCove Nerd Font Mono', 'Cascadia Mono NF', 'FiraCode Nerd Font Mono', 'JetBrainsMono Nerd Font Mono', 'Cascadia Mono', Consolas, Menlo, monospace",
  fontSize: 14,
  cursorShape: 'bar',
  cursorBlink: true,
  historySize: 9001,
  copyOnSelect: false,
  dragToSelect: true, // drag selects text even in CLIs that capture the mouse (clicks still reach them)
  confirmOnClose: true,
  profiles: [],
  agents: [],
  schemes: [],
  keybindings: {},
};

function detectShells() {
  if (IS_WIN) {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      { name: 'PowerShell', commandline: `${pf}\\PowerShell\\7\\pwsh.exe`, args: ['-NoLogo'], colorScheme: 'Campbell' },
      { name: 'Windows PowerShell', commandline: `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`, args: ['-NoLogo'], colorScheme: 'Campbell' },
      { name: 'Command Prompt', commandline: `${sys}\\System32\\cmd.exe`, args: [], colorScheme: 'Campbell' },
      { name: 'Git Bash', commandline: `${pf}\\Git\\bin\\bash.exe`, args: ['--login', '-i'] },
      { name: 'WSL', commandline: `${sys}\\System32\\wsl.exe`, args: [] },
    ].filter(p => fs.existsSync(p.commandline));
  }
  const shells = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/usr/bin/fish', '/bin/sh'];
  return [...new Set(shells)]
    .filter(s => s && fs.existsSync(s))
    .map(s => ({ name: path.basename(s), commandline: s, args: ['-l'] }));
}

function mergeBy(key, base, overrides) {
  const out = base.map(b => ({ ...b, ...(overrides.find(o => o[key] === b[key]) || {}) }));
  for (const o of overrides) if (!base.some(b => b[key] === o[key])) out.push(o);
  return out;
}

function readUser(file) {
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Returns { settings, error }. A broken file keeps defaults and reports the parse error.
function load(file) {
  let user = {}, error = null;
  try { user = readUser(file); } catch (e) { error = `settings.json: ${e.message}`; }
  const s = { ...DEFAULTS, ...user };
  s.tabMetadata = { ...DEFAULTS.tabMetadata, ...user.tabMetadata };
  s.profiles = mergeBy('name', detectShells(), user.profiles || []).filter(p => !p.hidden);
  s.agents = mergeBy('id', DEFAULT_AGENTS, user.agents || []).filter(a => !a.hidden);
  s.schemes = mergeBy('name', BUILTIN_SCHEMES, user.schemes || []);
  if (!s.profiles.some(p => p.name === s.defaultProfile)) s.defaultProfile = s.profiles[0]?.name || '';
  return { settings: s, error };
}

// Applies a top-level patch to the user's file. null deletes a key; profiles/agents merge by name/id.
function update(file, patch) {
  const user = readUser(file);
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete user[k];
    else if (k === 'profiles' || k === 'agents') user[k] = mergeBy(k === 'profiles' ? 'name' : 'id', user[k] || [], v);
    else if (k === 'tabMetadata' || k === 'keybindings') {
      user[k] = { ...user[k], ...v };
      for (const [kk, vv] of Object.entries(v)) if (vv === null) delete user[k][kk]; // null = back to default
    }
    else user[k] = v;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(user, null, 2) + '\n');
}

function expand(p) {
  if (!p) return p;
  p = p.replace(/%([^%]+)%/g, (m, v) => process.env[v] ?? m);
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

function resolveDir(dir) {
  const d = expand(dir || '~');
  try { if (fs.statSync(d).isDirectory()) return path.resolve(d); } catch { /* fall through to home */ }
  return os.homedir();
}

// Returns { file, args, env } with cwd-reporting shell integration for PowerShell, cmd and bash.
// Profiles that pass their own -Command/-File are left alone.
function shellLaunch(s, name) {
  const p = s.profiles.find(x => x.name === name);
  if (!p) return null;
  const file = expand(p.commandline);
  const args = [...(p.args || [])];
  const env = {};
  const exe = path.basename(file).toLowerCase().replace(/\.exe$/, '');
  if ((exe === 'pwsh' || exe === 'powershell') && !args.some(a => /^-(c|command|f|file|e|ec|encodedcommand)$/i.test(a))) {
    args.push('-NoExit', '-EncodedCommand', Buffer.from(PS_INTEGRATION, 'utf16le').toString('base64'));
  }
  if (exe === 'cmd') env.PROMPT = '$e]9;9;$P$e\\' + (process.env.PROMPT || '$P$G');
  if (exe === 'bash') {
    env.PROMPT_COMMAND = 'printf \'\\033]7;file://%s%s\\033\\\\\' "$HOSTNAME" "$PWD"'
      + (process.env.PROMPT_COMMAND ? `;${process.env.PROMPT_COMMAND}` : '');
  }
  return { file, args, env };
}

// Agents run through the platform shell so npm shims (.cmd/.ps1) and PATH lookups behave
// exactly like typing the command yourself.
function agentLaunch(s, id, resume) {
  const a = s.agents.find(x => x.id === id);
  if (!a) return null;
  // "|| plain command": resuming fails when the folder has no previous conversation; start fresh then.
  const command = resume && a.resumeArgs ? `${a.command} ${a.resumeArgs} || ${a.command}` : a.command;
  if (IS_WIN) return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${command}"` };
  return { file: process.env.SHELL || '/bin/sh', args: ['-lc', command] };
}

module.exports = { load, update, resolveDir, shellLaunch, agentLaunch, mergeBy };
