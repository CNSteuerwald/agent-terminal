'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../src/renderer/layout');

// Compact picture of a tree: groups as [a,b*] (* = active), splits as row(...)/col(...).
function shape(n) {
  if (!n) return 'empty';
  if (n.kind === 'group') return `[${n.panes.map((p, i) => p + (i === n.active && n.panes.length > 1 ? '*' : '')).join(',')}]`;
  return `${n.dir}(${n.children.map(shape).join(' ')})`;
}
const sizes = n => n.sizes.map(s => Math.round(s * 100));

test('split a group on each side', () => {
  const g = L.group(['shell']);
  let root = L.splitAt(g, g, L.group(['claude']), 'right');
  assert.equal(shape(root), 'row([shell] [claude])');
  root = L.splitAt(root, L.groupOf(root, 'claude'), L.group(['logs']), 'bottom');
  assert.equal(shape(root), 'row([shell] col([claude] [logs]))');
  root = L.splitAt(root, L.groupOf(root, 'shell'), L.group(['tests']), 'left');
  assert.equal(shape(root), 'row([tests] [shell] col([claude] [logs]))');
  assert.deepEqual(sizes(root), [25, 25, 50]); // the split side shares the target's half
});

test('removing panes collapses empty groups and single-child splits', () => {
  let root = L.split('row', [L.group(['a']), L.split('col', [L.group(['b']), L.group(['c'])])]);
  root = L.removePane(root, 'b');
  assert.equal(shape(root), 'row([a] [c])');
  root = L.removePane(root, 'c');
  assert.equal(shape(root), '[a]');
  assert.equal(L.removePane(root, 'a'), null);
});

test('same-direction splits flatten', () => {
  const root = L.normalize(L.split('row', [L.group(['a']), L.split('row', [L.group(['b']), L.group(['c'])])], [0.5, 0.5]));
  assert.equal(shape(root), 'row([a] [b] [c])');
  assert.deepEqual(sizes(root), [50, 25, 25]);
});

test('moving panes: split off, and no-op on itself', () => {
  let root = L.split('row', [L.group(['a']), L.group(['b']), L.group(['c'])]);
  root = L.movePane(root, 'c', L.groupOf(root, 'b'), 'bottom');
  assert.equal(shape(root), 'row([a] col([b] [c]))');
  const before = shape(root);
  root = L.movePane(root, 'a', L.groupOf(root, 'a'), 'right'); // only pane in its group
  assert.equal(shape(root), before);
  root = L.movePane(root, 'a', L.groupOf(root, 'c'), 'right');
  assert.equal(shape(root), 'col([b] row([c] [a]))'); // a's group emptied and the row collapsed
});

test('panes stacked by older versions open side by side', () => {
  assert.equal(shape(L.deserialize({ panes: [{ name: 'a' }, { name: 'b' }], active: 1 }, j => j.name)), 'row([a] [b])');
});

test('drop zones and their preview rects', () => {
  const r = { left: 0, top: 0, width: 400, height: 200 };
  assert.equal(L.dropZone(r, 20, 100), 'left');
  assert.equal(L.dropZone(r, 390, 100), 'right');
  assert.equal(L.dropZone(r, 200, 10), 'top');
  assert.equal(L.dropZone(r, 200, 195), 'bottom');
  assert.equal(L.dropZone(r, 200, 60), 'top'); // nearest edge, even from the middle
  assert.deepEqual(L.zoneRect(r, 'right'), { left: 200, top: 0, width: 200, height: 200 });
  assert.deepEqual(L.zoneRect(r, 'bottom'), { left: 0, top: 100, width: 400, height: 100 });
});

test('resize keeps a minimum size; serialize round-trips', () => {
  const root = L.split('row', [L.group(['a']), L.group(['b'])]);
  L.resize(root, 0, 0.9);
  assert.deepEqual(sizes(root), [92, 8]);
  const json = JSON.parse(JSON.stringify(L.serialize(root, p => ({ name: p }))));
  const back = L.deserialize(json, j => j.name);
  assert.equal(shape(back), 'row([a] [b])');
  assert.deepEqual(sizes(back), [92, 8]);
  assert.equal(L.deserialize({ panes: [{ name: 'gone' }] }, () => null), null); // panes that can't be restored
});
