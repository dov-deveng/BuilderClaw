/**
 * BuilderClaw — Electron Preload
 * Exposes safe APIs to the renderer process.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('builderclaw', {
  platform: process.platform,
  isElectron: true,
});
