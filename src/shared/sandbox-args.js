'use strict';
// New-sandbox form logic shared by the renderer (live validation, command preview) and main
// (validation again before running sbx). Pure, so it can be unit-tested.
(function (root) {
  // Built-in agents of `sbx create` (see `sbx create --help`).
  const AGENTS = ['claude', 'codex', 'copilot', 'cursor', 'devin', 'docker-agent', 'droid', 'kiro', 'opencode', 'shell'];
  const PART = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/;

  // sbx's naming rules: 2–63 letters, numbers, hyphens or periods; each dot-separated part starts and
  // ends with a letter or number; 'default' is reserved. Returns an error message, or '' when valid.
  function nameError(name, taken = []) {
    if (!name) return 'Enter a name.';
    if (name.length < 2 || name.length > 63) return 'Use 2 to 63 characters.';
    if (!/^[A-Za-z0-9.-]+$/.test(name)) return 'Use only letters, numbers, hyphens and periods.';
    if (!name.split('.').every(p => PART.test(p))) return 'Each part must start and end with a letter or number.';
    if (name.toLowerCase() === 'default') return '"default" is reserved.';
    if (taken.some(t => t.toLowerCase() === name.toLowerCase())) return 'A sandbox with this name already exists.';
    return '';
  }

  // sbx's own default: <agent>-<workdir>, made valid.
  function defaultName(agent, workspaces) {
    const dir = (workspaces[0]?.path || '').split(/[\\/]/).filter(Boolean).pop() || 'sandbox';
    const slug = `${agent}-${dir}`.replace(/[^A-Za-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    return slug.slice(0, 63).replace(/-$/, '');
  }

  // Arguments for `sbx create`. workspaces: [{ path, readOnly }]; kits: mixin references.
  function createArgs({ name, agent, kits = [], workspaces = [] }) {
    return ['create', '--name', name, ...kits.flatMap(k => ['--kit', k]), agent,
      ...workspaces.map(w => (w.readOnly ? `${w.path}:ro` : w.path))];
  }

  // Throws when opts can't be passed to sbx. Main runs this on whatever the renderer sends.
  function validate(opts, taken = []) {
    const { name, agent, kits, workspaces } = opts || {};
    const err = nameError(name, taken)
      || (!AGENTS.includes(agent) && `Unknown agent "${agent}".`)
      || (!Array.isArray(kits) || !kits.every(k => typeof k === 'string' && k.trim() && !k.startsWith('-')) ? 'Invalid kit reference.' : '')
      || (!Array.isArray(workspaces) || !workspaces.length ? 'Add at least one workspace folder.' : '')
      || (!workspaces.every(w => typeof w?.path === 'string' && w.path && !w.path.startsWith('-')) ? 'Invalid workspace folder.' : '');
    if (err) throw new Error(err);
    return opts;
  }

  // Remembered kits: the ones just used first, then the rest, without duplicates.
  const rememberKits = (saved = [], used = []) => [...new Set([...used, ...saved])].slice(0, 30);

  // Shell-style preview of the command, for display only.
  const quote = a => (/^[\w@%+=:,./\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  const preview = args => ['sbx', ...args].map(quote).join(' ');

  const api = { AGENTS, nameError, defaultName, createArgs, validate, rememberKits, preview };
  if (typeof module !== 'undefined') module.exports = api;
  else root.SandboxArgs = api;
})(typeof window !== 'undefined' ? window : globalThis);
