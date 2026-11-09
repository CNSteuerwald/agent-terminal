'use strict';
// Pane layout tree for one workspace tab. Pure data, no DOM, so it can be unit-tested.
//   split: { kind: 'split', dir: 'row' | 'col', children: [node, ...], sizes: [fractions summing to 1] }
//   group: { kind: 'group', panes: [pane, ...], active: index }   (a tab strip of stacked panes)
// Functions mutate in place and return the (possibly new) root, which is null once nothing is left.
(function (root) {
  const group = (panes = [], active = 0) => ({ kind: 'group', panes, active });
  const split = (dir, children, sizes) => ({ kind: 'split', dir, children, sizes: sizes || children.map(() => 1 / children.length) });

  function groups(node, out = []) {
    if (!node) return out;
    if (node.kind === 'group') out.push(node);
    else node.children.forEach(c => groups(c, out));
    return out;
  }

  const panes = node => groups(node).flatMap(g => g.panes);
  const groupOf = (node, pane) => groups(node).find(g => g.panes.includes(pane)) || null;

  // { parent, index } of node, or null for the root.
  function parentOf(node, target) {
    if (!node || node.kind === 'group') return null;
    for (let i = 0; i < node.children.length; i++) {
      if (node.children[i] === target) return { parent: node, index: i };
      const found = parentOf(node.children[i], target);
      if (found) return found;
    }
    return null;
  }

  // Collapses single-child splits, flattens a split into a same-direction parent, drops empty groups,
  // and renormalizes sizes. Returns the new root.
  function normalize(node) {
    if (!node) return null;
    if (node.kind === 'group') {
      if (!node.panes.length) return null;
      node.active = Math.min(Math.max(node.active, 0), node.panes.length - 1);
      return node;
    }
    const children = [], sizes = [];
    node.children.forEach((c, i) => {
      const n = normalize(c);
      if (!n) return;
      if (n.kind === 'split' && n.dir === node.dir) {
        n.children.forEach((cc, j) => { children.push(cc); sizes.push(node.sizes[i] * n.sizes[j]); });
      } else { children.push(n); sizes.push(node.sizes[i]); }
    });
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const total = sizes.reduce((a, b) => a + b, 0) || 1;
    node.children = children;
    node.sizes = sizes.map(s => s / total);
    return node;
  }

  function removePane(rootNode, pane) {
    const g = groupOf(rootNode, pane);
    if (!g) return rootNode;
    const i = g.panes.indexOf(pane);
    g.panes.splice(i, 1);
    if (g.active >= i && g.active > 0) g.active--;
    return normalize(rootNode);
  }

  function addToGroup(g, pane, index = g.panes.length) {
    g.panes.splice(Math.min(Math.max(index, 0), g.panes.length), 0, pane);
    g.active = g.panes.indexOf(pane);
    return g;
  }

  // Puts newGroup on `side` ('left' | 'right' | 'top' | 'bottom') of target (a group or split).
  // The target and the new group share the space the target had.
  function splitAt(rootNode, target, newGroup, side) {
    const dir = side === 'left' || side === 'right' ? 'row' : 'col';
    const before = side === 'left' || side === 'top';
    const at = parentOf(rootNode, target);
    if (at && at.parent.dir === dir) {
      const { parent, index } = at;
      const half = parent.sizes[index] / 2;
      parent.sizes[index] = half;
      parent.children.splice(before ? index : index + 1, 0, newGroup);
      parent.sizes.splice(before ? index : index + 1, 0, half);
      return normalize(rootNode);
    }
    const s = split(dir, before ? [newGroup, target] : [target, newGroup]);
    if (!at) return normalize(s);
    at.parent.children[at.index] = s;
    return normalize(rootNode);
  }

  // Moves pane next to / into target group. side: 'center' joins the group (at index), else splits it.
  function movePane(rootNode, pane, targetGroup, side, index) {
    const from = groupOf(rootNode, pane);
    if (!from || !targetGroup) return rootNode;
    if (side === 'center') {
      const fromIndex = from.panes.indexOf(pane);
      from.panes.splice(fromIndex, 1);
      if (from === targetGroup && index > fromIndex) index--;
      addToGroup(targetGroup, pane, index);
      if (from !== targetGroup && from.active >= fromIndex && from.active > 0) from.active--;
      return normalize(rootNode);
    }
    if (from === targetGroup && from.panes.length === 1) return rootNode; // splitting a pane off itself
    from.panes.splice(from.panes.indexOf(pane), 1);
    if (from.active >= from.panes.length) from.active = Math.max(0, from.panes.length - 1);
    return splitAt(rootNode, targetGroup, group([pane]), side);
  }

  // Which drop zone a point falls in, given the group's rect. edge: fraction of width/height that
  // counts as an edge (0.25 = outer quarter splits, the middle joins the group as a tab).
  function dropZone(rect, x, y, edge) {
    const fx = (x - rect.left) / rect.width, fy = (y - rect.top) / rect.height;
    const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
    const [side, dist] = Object.entries(d).sort((a, b) => a[1] - b[1])[0];
    return dist < edge ? side : 'center';
  }

  // The rect a drop would occupy, for the preview highlight.
  function zoneRect(rect, side) {
    const { left, top, width, height } = rect;
    if (side === 'left') return { left, top, width: width / 2, height };
    if (side === 'right') return { left: left + width / 2, top, width: width / 2, height };
    if (side === 'top') return { left, top, width, height: height / 2 };
    if (side === 'bottom') return { left, top: top + height / 2, width, height: height / 2 };
    return { left, top, width, height };
  }

  // Resize: moves the boundary after child `index` of a split by delta (fraction of the split).
  function resize(node, index, delta, min = 0.08) {
    const a = node.sizes[index], b = node.sizes[index + 1];
    const d = Math.max(min - a, Math.min(b - min, delta));
    node.sizes[index] = a + d;
    node.sizes[index + 1] = b - d;
  }

  function serialize(node, paneToJson) {
    if (!node) return null;
    if (node.kind === 'group') return { panes: node.panes.map(paneToJson), active: node.active };
    return { split: node.dir, sizes: node.sizes, children: node.children.map(c => serialize(c, paneToJson)) };
  }

  function deserialize(json, jsonToPane) {
    if (!json) return null;
    if (json.split) return normalize(split(json.split, json.children.map(c => deserialize(c, jsonToPane)), json.sizes));
    return normalize(group(json.panes.map(jsonToPane).filter(Boolean), json.active || 0));
  }

  const api = { group, split, groups, panes, groupOf, parentOf, normalize, removePane, addToGroup, splitAt, movePane, dropZone, zoneRect, resize, serialize, deserialize };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Layout = api;
})(typeof window !== 'undefined' ? window : globalThis);
