'use strict';
// Auto-update from the GitHub Releases that the release workflow publishes (see .github/workflows/release.yml).
// No dialogs: progress and "ready" show in the window's bottom bar (update:status). A downloaded update
// installs silently when the app quits, or right away via the bar's "Restart now" (update:install),
// which shows a small "Updating" window until the new version opens (update-splash.js).
const { app, BrowserWindow, ipcMain } = require('electron');
const { execFile } = require('child_process');
const { showUpdateSplash } = require('./update-splash');

const CHECK_EVERY_MS = 15 * 60 * 1000;

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
// The first check waits until a window asks (update:check), once its current tab is running; the
// returned promise settles when that check is done, so the window can then start its other tabs.
function start({ beforeInstall }) {
  let firstCheck = null;
  ipcMain.handle('update:check', () => (firstCheck ||= run().catch(() => {})));
  ipcMain.handle('update:get', () => status);
  ipcMain.on('update:install', () => {
    if (status?.state !== 'ready') return;
    showUpdateSplash({ version: status.version }); // the silent install otherwise shows nothing until the app reopens
    beforeInstall();
    autoUpdater.quitAndInstall(true, true); // silent install, then relaunch
  });
}

async function run() {
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
  // Settles once the check is done; a found update keeps downloading in the background.
  const check = () => (status?.state === 'ready' ? null : autoUpdater.checkForUpdates().catch(() => {}));
  setInterval(check, CHECK_EVERY_MS);
  await check();
}

module.exports = { start };
