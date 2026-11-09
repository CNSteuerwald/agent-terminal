'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: patch => ipcRenderer.invoke('settings:update', patch),
  openSettingsFile: which => ipcRenderer.invoke('settings:openFile', which),
  onSettings: cb => ipcRenderer.on('settings:changed', (_e, s) => cb(s)),

  spawn: opts => ipcRenderer.invoke('pty:spawn', opts),
  write: (id, data) => ipcRenderer.send('pty:write', id, data),
  resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
  kill: id => ipcRenderer.send('pty:kill', id),
  onData: cb => ipcRenderer.on('pty:data', (_e, id, data) => cb(id, data)),
  onExit: cb => ipcRenderer.on('pty:exit', (_e, id, code) => cb(id, code)),

  getInfo: req => ipcRenderer.invoke('info:get', req),
  getSession: () => ipcRenderer.invoke('session:get'),
  saveSession: s => ipcRenderer.send('session:save', s),
  sbxList: () => ipcRenderer.invoke('sbx:list'),
  onSbxOpen: cb => ipcRenderer.on('sbx:open', (_e, launch) => cb(launch)),
  detectSetup: () => ipcRenderer.invoke('setup:detect'),
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  getUpdateStatus: () => ipcRenderer.invoke('update:get'),
  onUpdateStatus: cb => ipcRenderer.on('update:status', (_e, s) => cb(s)),
  installUpdate: () => ipcRenderer.send('update:install'),
  uninstall: () => ipcRenderer.invoke('app:uninstall'),
  writeClipboard: text => ipcRenderer.send('clipboard:write', text),
  openExternal: url => ipcRenderer.send('shell:openExternal', url),
  openPath: p => ipcRenderer.send('shell:openPath', p),
  setTabCount: n => ipcRenderer.send('tabs:count', n),
  newWindow: () => ipcRenderer.send('window:new'),
  toggleWindow: what => ipcRenderer.send('window:toggle', what),
  platform: process.platform,
});
