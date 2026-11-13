'use strict';
// Per-tab metadata for the sidebar and pane headers: git status of the folder, the model the agent
// is using, and (Claude Code) its context use and cost.
const { execFile } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const home = os.homedir();

function parseGitStatus(out) {
  const info = { branch: null, ahead: 0, behind: 0, changes: 0 };
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim();
    else if (line.startsWith('# branch.ab ')) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) { info.ahead = +m[1]; info.behind = +m[2]; }
    } else if (line && !line.startsWith('#')) info.changes++;
  }
  return info;
}

function gitInfo(dir) {
  return new Promise(resolve => execFile(
    'git', ['-C', dir, 'status', '--porcelain=v2', '--branch'],
    // GIT_OPTIONAL_LOCKS=0: polling must never block or fight the agent's own git commands.
    { timeout: 3000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
    (err, out) => resolve(err ? null : parseGitStatus(out)),
  ));
}

// Claude Code stores transcripts in ~/.claude/projects/<cwd with non-alphanumerics replaced by '-'>.
function claudeProjectDir(cwd) {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return path.join(base, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
}

// Last "model":"..." key in JSONL text, skipping placeholders like "<synthetic>".
function lastModel(text) {
  let last = null;
  for (const m of text.matchAll(/"model"\s*:\s*"([^"]+)"/g)) if (!m[1].startsWith('<')) last = m[1];
  return last;
}

function modelFromCommand(cmd) {
  const m = (cmd || '').match(/(?:^|\s)(?:--model|-m)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/);
  return m ? m[1] || m[2] || m[3] : null;
}

async function readText(file, maxBytes) {
  try {
    const fh = await fs.open(file);
    try {
      const { size } = await fh.stat();
      const len = Math.min(size, maxBytes ?? size);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, size - len);
      return buf.toString('utf8');
    } finally { await fh.close(); }
  } catch { return null; }
}

async function readJson(file) {
  try { return JSON.parse(await readText(file)); } catch { return null; }
}

// The newest transcript written since the agent started, or null. created: only count files created
// since then, so another Claude session in the same folder isn't mistaken for a new one.
// shortcut: a resumed agent takes the newest-written file; two live resumed sessions in one folder can mix up.
async function newestTranscript(cwd, since, created = false) {
  const dir = claudeProjectDir(cwd);
  try {
    const files = await Promise.all((await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'))
      .map(async f => { const st = await fs.stat(path.join(dir, f)); return { f, t: created ? st.birthtimeMs : st.mtimeMs }; }));
    const newest = files.filter(x => x.t >= since).sort((a, b) => b.t - a.t)[0];
    return newest ? path.join(dir, newest.f) : null;
  } catch { return null; } // no transcripts yet
}

// Model from the newest transcript (reflects /model switches).
async function claudeTranscriptModel(cwd, since) {
  const file = await newestTranscript(cwd, since);
  return file ? lastModel(await readText(file, 256 * 1024) || '') : null;
}

// [model id pattern, $/M input, $/M output, $/M cache read, context window]. Cache writes cost
// 1.25x input (5 min) or 2x (1 h); fast mode doubles everything. Unlisted models count as $0.
// shortcut: prices as of 2026-11 (Haiku 5.5's >100K-token rate ignored); update when models change.
const MODELS = [
  [/fable-5-2|mythos-5-2/, 8, 40, 0.2, 1e6],
  [/fable-5|mythos-5/, 10, 50, 1, 1e6],
  [/opus-5-5/, 4, 20, 0.2, 1e6],
  [/opus-(5|4-[678])/, 5, 25, 0.5, 1e6],
  [/sonnet-5-5/, 2, 10, 0.1, 1e6],
  [/sonnet-5/, 2, 10, 0.2, 1e6],
  [/sonnet-4-6/, 3, 15, 0.3, 1e6],
  [/haiku-5-5/, 0.1, 0.5, 0.01, 1e6],
  [/haiku-4-5/, 1, 5, 0.1, 2e5],
];
const modelSpec = id => MODELS.find(([re]) => re.test(id)) || null;

function messageCost(model, u) {
  const spec = modelSpec(model);
  if (!spec) return 0;
  const [, input, output, read] = spec;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  const w5m = u.cache_creation ? u.cache_creation.ephemeral_5m_input_tokens || 0 : u.cache_creation_input_tokens || 0;
  const usd = (u.input_tokens || 0) * input + (u.output_tokens || 0) * output + (u.cache_read_input_tokens || 0) * read
    + w5m * input * 1.25 + w1h * input * 2;
  return usd / 1e6 * (u.speed === 'fast' ? 2 : 1);
}

// Folds one transcript line into c. A message written as several lines (one per content block)
// repeats its usage, so cost is kept per message id.
function addUsageLine(c, line) {
  if (!line.includes('"usage"')) return;
  let j;
  try { j = JSON.parse(line); } catch { return; }
  const m = j.message, u = m?.usage;
  if (j.type !== 'assistant' || !u || !m.model || m.model.startsWith('<')) return;
  c.costs.set(m.id, messageCost(m.model, u));
  if (!j.isSidechain) {
    c.last = { model: m.model, context: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) };
  }
}

// Transcripts only grow, so each poll reads just the new bytes.
const usageCache = new Map(); // file -> { offset, rest, costs: Map(message id -> $), last }
async function transcriptUsage(file) {
  let c = usageCache.get(file);
  if (!c) usageCache.set(file, c = { offset: 0, rest: Buffer.alloc(0), costs: new Map(), last: null });
  const fh = await fs.open(file);
  try {
    const { size } = await fh.stat();
    if (size > c.offset) {
      const buf = Buffer.alloc(size - c.offset);
      await fh.read(buf, 0, buf.length, c.offset);
      c.offset = size;
      const data = Buffer.concat([c.rest, buf]);
      const end = data.lastIndexOf(10) + 1; // a partly written last line waits for the next poll
      c.rest = data.subarray(end);
      for (const line of data.subarray(0, end).toString('utf8').split('\n')) addUsageLine(c, line);
    }
  } finally { await fh.close(); }
  return c;
}

// { model, modelLabel, context, window, cost } for a Claude Code pane, or null (other agents, no transcript yet).
async function agentUsage({ cwd, agentId, since, resumed }) {
  if (agentId !== 'claude') return null;
  const file = await newestTranscript(cwd, since || 0, !resumed);
  if (!file) return null;
  try {
    const c = await transcriptUsage(file);
    if (!c.last) return null;
    const { model, context } = c.last;
    const window = Math.max(modelSpec(model)?.[4] || 2e5, context > 2e5 ? 1e6 : 0);
    let cost = 0;
    for (const v of c.costs.values()) cost += v;
    return { model, modelLabel: prettyModel(model), context, window, cost };
  } catch { return null; }
}

// Name of the git repository dir is in: its nearest ancestor holding .git.
async function repoName(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try { await fs.stat(path.join(d, '.git')); return path.basename(d); } catch { /* keep looking */ }
    if (path.dirname(d) === d) return null;
  }
}

async function claudeConfigModel(cwd) {
  for (const f of [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'),
    path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json')]) {
    const s = await readJson(f);
    if (s?.model) return s.model;
  }
  return process.env.ANTHROPIC_MODEL || null;
}

const CONFIG_MODEL = {
  async codex() {
    const toml = await readText(path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'));
    return toml?.match(/^\s*model\s*=\s*"([^"]+)"/m)?.[1] || null;
  },
  async gemini() {
    const s = await readJson(path.join(home, '.gemini', 'settings.json'));
    return s?.model?.name || (typeof s?.model === 'string' ? s.model : null);
  },
  async copilot() {
    return (await readJson(path.join(home, '.copilot', 'config.json')))?.model || null;
  },
  async opencode(cwd) {
    return (await readJson(path.join(cwd, 'opencode.json')))?.model
      || (await readJson(path.join(home, '.config', 'opencode', 'opencode.json')))?.model || null;
  },
};

async function agentModel({ cwd, agentId, command, since }) {
  if (agentId === 'claude') {
    return await claudeTranscriptModel(cwd, since) || modelFromCommand(command) || claudeConfigModel(cwd);
  }
  return modelFromCommand(command) || (await CONFIG_MODEL[agentId]?.(cwd)) || null;
}

// Short display name for a model id: "claude-opus-5-5" -> "Opus 5.5", "claude-sonnet-4-5-20250929" -> "Sonnet 4.5".
// Other ids are shown as they are.
function prettyModel(id) {
  const m = id?.match(/^claude-([a-z]+)((?:-\d+)+?)(?:-\d{8})?(\[1m\])?$/);
  if (!m) return id || null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].slice(1).replace(/-/g, '.')}${m[3] ? ' (1M)' : ''}`;
}

async function getInfo(req) {
  // Git follows the shell's folder; the model comes from where the agent was started.
  const agentReq = { ...req, cwd: req.agentCwd || req.cwd };
  const [git, model] = await Promise.all([gitInfo(req.cwd), req.agentId ? agentModel(agentReq) : null]);
  if (git) git.repo = await repoName(req.cwd);
  return { git, model, modelLabel: prettyModel(model) };
}

module.exports = { getInfo, agentUsage, prettyModel, parseGitStatus, claudeProjectDir, lastModel, modelFromCommand, messageCost, addUsageLine };
