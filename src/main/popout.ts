import { BrowserWindow } from 'electron';
import path from 'node:path';
import { IpcChannel } from '../shared/types';
import { readSettings } from './settings';
import { handleWindowMoved, reapplyOnResize } from './window-controls';
import { appBarOwner, removeAppBar } from './appbar';

/**
 * The pop-out visualizer: a second, frameless, always-on-top window that shows
 * only the waveform plus (optionally) the transport buttons.
 *
 * It does NOT open its own capture — the WASAPI helper is single-instance and
 * a second desktopCapturer stream would double the CPU cost for nothing.
 * Instead the main renderer streams analyser frames over IPC (`viz:frame`) and
 * the pop-out sends commands back (`viz:command`). Main is just the relay.
 */

const isDev = process.env.NODE_ENV === 'development';

let popoutWindow: BrowserWindow | null = null;

export function getPopout(): BrowserWindow | null {
  return popoutWindow && !popoutWindow.isDestroyed() ? popoutWindow : null;
}

export function isPopoutOpen(): boolean {
  return getPopout() !== null;
}

export function createPopout(onClosed?: () => void): BrowserWindow {
  const existing = getPopout();
  if (existing) {
    existing.show();
    existing.focus();
    return existing;
  }

  const s = readSettings();

  popoutWindow = new BrowserWindow({
    width: 460,
    height: 210,
    minWidth: 160,
    minHeight: 70,
    frame: false,
    transparent: false,
    backgroundColor: '#05070f',
    alwaysOnTop: s.popoutAlwaysOnTop,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    title: 'Faze — Visualizer',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  if (s.popoutAlwaysOnTop) {
    try { popoutWindow.setAlwaysOnTop(true, 'floating'); } catch { /* ignore */ }
  }
  try { popoutWindow.setOpacity(clampOpacity(s.popoutOpacity)); } catch { /* ignore */ }

  // The renderer bundle is one page; `#popout` selects the pop-out root.
  if (isDev) {
    void popoutWindow.loadURL('http://localhost:5173/#popout');
  } else {
    void popoutWindow.loadFile(path.join(__dirname, '../renderer/index.html'), {
      hash: 'popout',
    });
  }

  popoutWindow.once('ready-to-show', () => popoutWindow?.show());
  popoutWindow.on('closed', () => {
    // If the pop-out was the docked strip, its reservation dies with it —
    // otherwise the shell keeps holding space for a window that no longer
    // exists.
    if (appBarOwner() === popoutWindow) removeAppBar();
    popoutWindow = null;
    onClosed?.();
  });

  // Same drop-near-an-edge behaviour the main window has. Without this the
  // pop-out was the one window you *couldn't* dock, which is backwards — it's
  // the one most likely to live along the top of a monitor.
  popoutWindow.on('moved', () => handleWindowMoved(getPopout()));
  popoutWindow.on('resized', () => reapplyOnResize(getPopout()));

  return popoutWindow;
}

export function destroyPopout() {
  const w = getPopout();
  if (w) w.close();
  popoutWindow = null;
}

/** Push live analyser data to the pop-out. No-op when it isn't open. */
export function forwardVizFrame(payload: unknown) {
  const w = getPopout();
  if (w) w.webContents.send(IpcChannel.vizFrame, payload);
}

/** Push the slower-moving state (capturing, buffer fill, theme…). */
export function forwardVizState(payload: unknown) {
  const w = getPopout();
  if (w) w.webContents.send(IpcChannel.vizState, payload);
}

export function forwardVizHistory(payload: unknown) {
  const w = getPopout();
  if (w) w.webContents.send(IpcChannel.vizHistory, payload);
}

/** Re-apply the pop-out's window-level settings after a settings save. */
export function applyPopoutSettings() {
  const w = getPopout();
  if (!w) return;
  const s = readSettings();
  try { w.setAlwaysOnTop(s.popoutAlwaysOnTop, 'floating'); } catch { /* ignore */ }
  try { w.setOpacity(clampOpacity(s.popoutOpacity)); } catch { /* ignore */ }
}

function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return 1;
  return Math.min(1, Math.max(0.2, v));
}
