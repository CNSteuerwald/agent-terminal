'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const AgentIcons = require('../src/renderer/icons');
const settings = require('../src/main/settings');

test('every icon is a 16x16 svg drawn in currentColor', () => {
  assert.ok(AgentIcons.names.length >= 12);
  for (const name of AgentIcons.names) {
    const svg = AgentIcons.svg(name);
    assert.match(svg, /^<svg viewBox="0 0 16 16"/, name);
    assert.match(svg, /currentColor/, name);
    assert.match(svg, /class="p-/, `${name} has an animated part`);
    assert.ok(AgentIcons.label(name), name);
  }
  assert.equal(AgentIcons.svg('nope'), AgentIcons.svg('spark')); // unknown names fall back
});

test('animated parts all have styles', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/renderer/styles.css'), 'utf8');
  const parts = new Set(AgentIcons.names.flatMap(n => [...AgentIcons.svg(n).matchAll(/class="([^"]+)"/g)].flatMap(m => m[1].split(' '))));
  for (const cls of parts) assert.ok(css.includes(`.${cls}`), `${cls} is styled`);
});

test('built-in agents get valid default icons, and user picks override them', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'at-')), 'settings.json');
  for (const a of settings.load(file).settings.agents) assert.ok(AgentIcons.has(a.icon), a.id);
  settings.update(file, { agents: [{ id: 'claude', icon: 'cat', iconColor: '#3FB950' }] });
  const claude = settings.load(file).settings.agents.find(a => a.id === 'claude');
  assert.equal(claude.icon, 'cat');
  assert.equal(claude.iconColor, '#3FB950');
  settings.update(file, { agents: [{ id: 'claude', icon: undefined, iconColor: undefined }] }); // "Reset to default"
  assert.equal(settings.load(file).settings.agents.find(a => a.id === 'claude').icon, 'spark');
});
