'use strict';
// Agent icons: small 16x16 SVGs drawn in currentColor (the agent's color). Parts with a p-* class
// animate while the agent works; the keyframes are in styles.css ("agent icons").
(function (root) {
  const svg = body => `<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">${body}</svg>`;
  const cut = 'fill="#000" fill-opacity=".55"'; // eyes and windows: darker than the icon in any color

  const ICONS = {
    spark: ['Spark', svg(`
      <g class="p-spin"><path d="M8 1.2C8.5 5.3 10.7 7.5 14.8 8 10.7 8.5 8.5 10.7 8 14.8 7.5 10.7 5.3 8.5 1.2 8 5.3 7.5 7.5 5.3 8 1.2Z" fill="currentColor"/></g>
      <circle class="p-tw p-tw1" cx="13.4" cy="2.6" r="1.1" fill="currentColor"/>
      <circle class="p-tw p-tw2" cx="2.6" cy="13.4" r=".9" fill="currentColor"/>`)],
    orbit: ['Orbit', svg(`
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-opacity=".35" stroke-width="1.1"/>
      <circle class="p-core" cx="8" cy="8" r="2.8" fill="currentColor"/>
      <g class="p-orbit"><circle cx="14.2" cy="8" r="1.7" fill="currentColor"/></g>`)],
    robot: ['Robot', svg(`
      <line x1="8" y1="2.8" x2="8" y2="5" stroke="currentColor" stroke-width="1.3"/>
      <circle class="p-beacon" cx="8" cy="2.2" r="1.4" fill="currentColor"/>
      <rect x="2.4" y="5" width="11.2" height="8.6" rx="2.6" fill="currentColor"/>
      <g class="p-look"><rect x="5" y="7.8" width="2" height="2.6" rx="1" ${cut}/><rect x="9" y="7.8" width="2" height="2.6" rx="1" ${cut}/></g>
      <rect x="0.6" y="8" width="1.3" height="3" rx=".6" fill="currentColor"/><rect x="14.1" y="8" width="1.3" height="3" rx=".6" fill="currentColor"/>`)],
    cube: ['Cube', svg(`
      <path class="p-face p-f1" d="M8 1.6 13.6 4.8 8 8 2.4 4.8Z" fill="currentColor"/>
      <path class="p-face p-f2" d="M2.4 4.8 8 8v6.4l-5.6-3.2Z" fill="currentColor"/>
      <path class="p-face p-f3" d="M13.6 4.8 8 8v6.4l5.6-3.2Z" fill="currentColor"/>`)],
    bars: ['Equalizer', svg(`
      <rect class="p-bar" x="1.6" y="7" width="2.4" height="7.4" rx="1.1" fill="currentColor"/>
      <rect class="p-bar p-b2" x="5.2" y="3" width="2.4" height="11.4" rx="1.1" fill="currentColor"/>
      <rect class="p-bar p-b3" x="8.8" y="5.4" width="2.4" height="9" rx="1.1" fill="currentColor"/>
      <rect class="p-bar p-b4" x="12.4" y="8.6" width="2.4" height="5.8" rx="1.1" fill="currentColor"/>`)],
    gear: ['Gear', svg(`
      <g class="p-gear" fill="none" stroke="currentColor">
        <circle cx="8" cy="8" r="4.1" stroke-width="2.1"/>
        <path d="M8 1.3v2M8 12.7v2M1.3 8h2M12.7 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M3.3 12.7l1.4-1.4M11.3 4.7l1.4-1.4" stroke-width="2.3" stroke-linecap="round"/>
      </g>
      <circle cx="8" cy="8" r="1.4" fill="currentColor"/>`)],
    atom: ['Atom', svg(`
      <g class="p-atom" fill="none" stroke="currentColor" stroke-width="1.1">
        <ellipse cx="8" cy="8" rx="6.8" ry="2.6"/>
        <ellipse cx="8" cy="8" rx="6.8" ry="2.6" style="transform: rotate(60deg)"/>
        <ellipse cx="8" cy="8" rx="6.8" ry="2.6" style="transform: rotate(120deg)"/>
      </g>
      <circle class="p-core" cx="8" cy="8" r="1.8" fill="currentColor"/>`)],
    ghost: ['Ghost', svg(`
      <g class="p-float">
        <path d="M2.8 14.4V7.4a5.2 5.2 0 0 1 10.4 0v7l-1.7-1.3-1.7 1.3L8 13.1l-1.8 1.3-1.7-1.3Z" fill="currentColor"/>
        <g class="p-blink"><ellipse cx="6.2" cy="7.4" rx="1" ry="1.35" ${cut}/><ellipse cx="9.8" cy="7.4" rx="1" ry="1.35" ${cut}/></g>
      </g>`)],
    flame: ['Flame', svg(`
      <path class="p-flicker" d="M8 1c.5 2.7 4.8 4.6 4.8 8.6A4.8 4.8 0 0 1 3.2 9.6c0-2 1-3.4 2.3-4.4-.1 1.7.6 2.7 1.7 3.1C7.1 6.3 7.4 3.5 8 1Z" fill="currentColor"/>
      <path class="p-ember" d="M8 8.7c.9 1 1.9 1.9 1.9 3.2a1.9 1.9 0 0 1-3.8 0c0-1.3 1-2.2 1.9-3.2Z" fill="#fff" fill-opacity=".6"/>`)],
    terminal: ['Terminal', svg(`
      <rect x="1.3" y="2.4" width="13.4" height="11.2" rx="2.4" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <path class="p-nudge" d="M4.2 6.1 6.6 8.1 4.2 10.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
      <rect class="p-cursor" x="8" y="9.3" width="3.8" height="1.6" rx=".6" fill="currentColor"/>`)],
    rocket: ['Rocket', svg(`
      <path class="p-exhaust" d="M6.5 12.3h3L8 15.6Z" fill="currentColor" fill-opacity=".75"/>
      <g class="p-lift">
        <path d="M8 .9c2.5 1.7 3.5 4.4 3.3 7.9l1.6 1.9-.3 2.2-2.6-1.3H6l-2.6 1.3-.3-2.2 1.6-1.9C4.5 5.3 5.5 2.6 8 .9Z" fill="currentColor"/>
        <circle cx="8" cy="6" r="1.35" ${cut}/>
      </g>`)],
    eye: ['Eye', svg(`
      <g class="p-blinkall">
        <path d="M1 8C2.9 4.7 5.3 3.3 8 3.3s5.1 1.4 7 4.7c-1.9 3.3-4.3 4.7-7 4.7S2.9 11.3 1 8Z" fill="none" stroke="currentColor" stroke-width="1.4"/>
        <g class="p-pupil"><circle cx="8" cy="8" r="2.4" fill="currentColor"/></g>
      </g>`)],
    pulse: ['Pulse', svg(`
      <path d="M.8 8.6h3.1l1.6-4.3 2.7 8.2 2-6.1 1.3 2.2h3.7" fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path class="p-trace" d="M.8 8.6h3.1l1.6-4.3 2.7 8.2 2-6.1 1.3 2.2h3.7" pathLength="100" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)],
    cat: ['Cat', svg(`
      <g class="p-tilt">
        <path d="M2.5 6.4 2.8 1.6l3.3 2.8h3.8l3.3-2.8.3 4.8c.8 1 1.2 2.1 1.2 3.4 0 3-3 4.9-6.7 4.9S1.3 12.8 1.3 9.8c0-1.3.4-2.4 1.2-3.4Z" fill="currentColor"/>
        <g class="p-blink"><ellipse cx="5.7" cy="9" rx=".95" ry="1.25" ${cut}/><ellipse cx="10.3" cy="9" rx=".95" ry="1.25" ${cut}/></g>
      </g>`)],
  };

  const api = {
    names: Object.keys(ICONS),
    has: name => Object.hasOwn(ICONS, name),
    label: name => ICONS[name]?.[0] || name,
    svg: name => (ICONS[name] || ICONS.spark)[1],
  };
  if (typeof module !== 'undefined') module.exports = api;
  else root.AgentIcons = api;
})(typeof window !== 'undefined' ? window : globalThis);
