'use strict';
// Auto-update from the GitHub Releases that the release workflow publishes (see .github/workflows/release.yml).
// No dialogs: progress and "ready" show in the window's bottom bar (update:status). A downloaded update
// installs silently when the app quits, or right away via the bar's "Restart now" (update:install).
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

let status = null; // null | { state: 'downloading' | 'ready', version, percent }
let autoUpdater = null;

// shortcut: the repo is private, so release downloads need a GitHub token; we borrow the user's
// GitHub CLI login (`gh auth login`). Remove this (and `private: true` in package.json) once the repo is public.
function ghToken() {
  return new Promise(resolve => execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 10000 },
    (err, out) => resolve(err ? '' : out.trim())));
}

function setStatus(next) {
  status = next;
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:status', status);
}

// beforeInstall: called right before quitting to install (lets main skip the "close N tabs?" prompt).
async function start({ beforeInstall }) {
  ipcMain.handle('update:get', () => status);
  ipcMain.on('update:install', () => {
    if (status?.state !== 'ready') return;
    beforeInstall();
    autoUpdater.quitAndInstall(true, true); // silent install, then relaunch
  });

  if (!app.isPackaged) return; // `npm start` runs from source; nothing to update
  ({ autoUpdater } = require('electron-updater'));
  process.env.GH_TOKEN ||= await ghToken();
  if (!process.env.GH_TOKEN) return; // not signed in to gh: updates are manual (README → Updating)

  autoUpdater.autoInstallOnAppQuit = true; // "Later" = installs on the next quit, so the next launch is updated
  autoUpdater.on('update-available', info => setStatus({ state: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', p => {
    const percent = Math.floor(p.percent);
    if (status?.state === 'downloading' && percent !== status.percent) setStatus({ ...status, percent });
  });
  autoUpdater.on('update-downloaded', info => setStatus({ state: 'ready', version: info.version }));
  autoUpdater.on('error', err => {
    console.error('update failed:', err?.message || err);
    if (status?.state === 'downloading') setStatus(null); // don't leave a stuck progress message
  });
  const check = () => { if (status?.state !== 'ready') autoUpdater.checkForUpdates().catch(() => {}); };
  check();
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { start };
