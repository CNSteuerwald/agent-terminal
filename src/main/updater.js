'use strict';
// Auto-update from the GitHub Releases that the release workflow publishes (see .github/workflows/release.yml).
const { app, dialog } = require('electron');
const { execFile } = require('child_process');

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;

// shortcut: the repo is private, so release downloads need a GitHub token; we borrow the user's
// GitHub CLI login (`gh auth login`). Remove this (and `private: true` in package.json) once the repo is public.
function ghToken() {
  return new Promise(resolve => execFile('gh', ['auth', 'token'], { windowsHide: true, timeout: 10000 },
    (err, out) => resolve(err ? '' : out.trim())));
}

async function start() {
  if (!app.isPackaged) return; // `npm start` runs from source; nothing to update
  const { autoUpdater } = require('electron-updater');
  process.env.GH_TOKEN ||= await ghToken();
  if (!process.env.GH_TOKEN) return; // not signed in to gh: updates are manual (README → Updating)

  autoUpdater.on('error', err => console.error('update check failed:', err?.message || err));
  autoUpdater.on('update-downloaded', async info => {
    const { response } = await dialog.showMessageBox({
      type: 'info', buttons: ['Restart now', 'Later'], defaultId: 0, cancelId: 1,
      message: `Agent Terminal ${info.version} is ready to install.`,
      detail: 'Restart now, or it installs automatically the next time you quit. Your tabs reopen after restarting.',
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  const check = () => autoUpdater.checkForUpdates().catch(() => {}); // failures are reported via 'error'
  check();
  setInterval(check, CHECK_EVERY_MS);
}

module.exports = { start };
