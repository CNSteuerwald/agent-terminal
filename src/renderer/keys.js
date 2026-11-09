'use strict';
// Key combos are written like "ctrl+shift+t": modifiers in the order ctrl, alt, shift, meta,
// then the key. Uses KeyboardEvent.code so Shift doesn't change the key name ("ctrl+shift+.").
(function (root) {
  const CODE_NAMES = {
    Period: '.', Comma: ',', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', Semicolon: ';',
    Quote: "'", Backquote: '`', BracketLeft: '[', BracketRight: ']', Space: 'space',
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    PageUp: 'pgup', PageDown: 'pgdn', Escape: 'esc', Enter: 'enter', NumpadEnter: 'enter',
    NumpadAdd: 'numpad_plus', NumpadSubtract: 'numpad_minus',
  };
  const MODS = ['ctrl', 'alt', 'shift', 'meta'];

  function keyName(code) {
    if (CODE_NAMES[code]) return CODE_NAMES[code];
    const m = code.match(/^(?:Key|Digit)(.)$/) || code.match(/^Numpad(\d)$/);
    if (m) return code.startsWith('Numpad') ? `numpad_${m[1]}` : m[1].toLowerCase();
    return code.toLowerCase(); // F5 -> f5, Tab -> tab, Home -> home, Insert -> insert
  }

  function eventToKey(e) {
    if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(e.code)) return null; // modifier alone
    return [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'meta', keyName(e.code)]
      .filter(Boolean).join('+');
  }

  // Canonical form for user-typed combos: "Shift+Ctrl+T" -> "ctrl+shift+t", "ctrl+plus" -> "ctrl+=".
  function normalize(combo) {
    const parts = String(combo).toLowerCase().split('+').map(s => s.trim());
    // "ctrl++" splits into a trailing empty part: that's the plus key.
    let key = parts.pop() || '=';
    key ={ plus: '=', period: '.', comma: ',', escape: 'esc', return: 'enter' }[key] || key;
    const mods = MODS.filter(m => parts.includes(m) || (m === 'ctrl' && parts.includes('control')));
    return [...mods, key].join('+');
  }

  const api = { eventToKey, normalize };
  if (typeof module !== 'undefined') module.exports = api;
  else root.Keys = api;
})(typeof window !== 'undefined' ? window : globalThis);
