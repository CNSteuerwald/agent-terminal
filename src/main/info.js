'use strict';
// Per-tab metadata for the sidebar: git status of the folder and the model the agent is using.
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

// Model from the newest transcript written since the tab's agent started (reflects /model switches).
async function claudeTranscriptModel(cwd, since) {
  const dir = claudeProjectDir(cwd);
  try {
    const files = await Promise.all((await fs.readdir(dir)).filter(f => f.endsWith('.jsonl'))
      .map(async f => ({ f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
    const newest = files.filter(x => x.t >= since).sort((a, b) => b.t - a.t)[0];
    return newest ? lastModel(await readText(path.join(dir, newest.f), 256 * 1024) || '') : null;
  } catch { return null; } // no transcripts yet
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

async function getInfo(req) {
  // Git follows the shell's folder; the model comes from where the agent was started.
  const agentReq = { ...req, cwd: req.agentCwd || req.cwd };
  const [git, model] = await Promise.all([gitInfo(req.cwd), req.agentId ? agentModel(agentReq) : null]);
  return { git, model };
}

module.exports = { getInfo, parseGitStatus, claudeProjectDir, lastModel, modelFromCommand };
