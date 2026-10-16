import { app, BrowserWindow, Menu, screen } from 'electron';
import path from 'node:path';
import { readSettings, writeSettings } from './settings';
import { HotkeyManager } from './hotkeys';
import {
  AppSettings,
  IpcChannel,
  LAYOUT_MIN_SIZE,
  RecorderEvent,
} from '../shared/types';
import { registerIpc } from './ipc';
import { initTray, destroyTray, makeAppIcon } from './tray';
import { handleWindowMoved, reapplyOnResize } from './window-controls';
import {
  appBarOwner,
  reapplyAppBar,
  reclaimStaleAppBar,
  removeAppBar,
  wireAppBarTeardown,
} from './appbar';
import { applyPopoutSettings, createPopout, destroyPopout, getPopout } from './popout';

const isDev = process.env.NODE_ENV === 'development';


let mainWindow: BrowserWindow | null = null;
/** Title-bar mode the live window was built with — a change needs a rebuild. */
let builtTitleBarMode: AppSettings['titleBarMode'] = 'custom';
/** Last seen `popoutOpen`, so the hide/show policy fires on transitions only. */
let lastPopoutOpen = false;
/** Set when the app starts straight into pop-out mode — don't flash the main
 *  window on screen just to hide it again a frame later. */
let suppressInitialShow = false;
/** Set while we tear the window down on purpose (frame change), so the
 *  hide-on-close handler doesn't intercept and the app doesn't quit. */
let recreating = false;
const hotkeyMgr = new HotkeyManager();

function createWindow(bounds?: Electron.Rectangle) {
  const settings = readSettings();
  builtTitleBarMode = settings.titleBarMode;
  // The synth view (App.tsx / SynthView.tsx) only ever renders the 'full'
  // layout now — `uiLayout` is a leftover from the retired recorder UI's
  // compact mode, which no longer has any rendered form. Enforcing its
  // (much smaller) floor here let a stale `uiLayout: 'compact'` in
  // faze-settings.json shrink the window's minimum size to 200x32,
  // well below what the synth grid actually needs — the window could then
  // be dragged small enough to clip the bottom of the layout. Always use
  // `full`'s floor regardless of the persisted value.
  const min = LAYOUT_MIN_SIZE.full;
  // `minWidth`/`minHeight` below only stop the user from resizing SMALLER
  // than the floor — they do NOT retroactively bump an explicit initial
  // `width`/`height` up to that floor if it's already under it (observed:
  // a fresh window can come up with `bounds.height` under `minHeight` on
  // this environment, likely from Electron/Chromium's own centering-on-
  // display logic clamping to a work area shorter than 980, e.g. a scaled
  // or secondary display). Clamp explicitly so the window is never BORN
  // smaller than its own declared minimum.
  // 1240 -> 1140: the modulator strip moved below the oscillators instead
  // of beside them (todo.md §58), so the default window no longer needs to
  // be as wide — user feedback: "the synth is looking a bit too long
  // (width)... reduce the max width a lil bit".
  const initialWidth = Math.max(min.width, bounds?.width ?? 1140);
  const initialHeight = Math.max(min.height, bounds?.height ?? 820);

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x: bounds?.x,
    y: bounds?.y,
    // The floor tracks the active layout (see LAYOUT_MIN_SIZE): `bar` is a
    // 34px strip, `full` still has to fit the visualizer. main re-clamps this
    // whenever the renderer switches layout.
    minWidth: min.width,
    minHeight: min.height,
    // 'custom' drops the OS title bar entirely; the renderer draws a 26px
    // strip instead (src/renderer/components/TitleBar.tsx).
    frame: settings.titleBarMode !== 'custom',
    title: 'Faze',
    // The window's own backdrop, behind the page. It was hardcoded to the old
    // `:root` `#070a1c`, a blue-grey LIGHTER than Aurora ice (#02030a) and
    // Graphite (#0b0c0e) — so it showed as a pale wash during load and resize,
    // and it ignored the theme entirely. Pure black is the floor every theme
    // sits above, so this can only ever be too dark, never washed out. The
    // renderer's `html` now paints the real theme colour immediately on top.
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false, // show after ready-to-show
    icon: makeAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // This window is the audio engine, not just a view: it owns the
      // AnalyserNode, the rolling-buffer bookkeeping and the frame pump that
      // feeds the pop-out. Chromium throttles timers and animation frames to a
      // crawl for backgrounded windows — and Faze spends most of its life
      // minimised or hidden to the tray, which is exactly when it must keep
      // running.
      backgroundThrottling: false,
    },
  });

  Menu.setApplicationMenu(null);

  // Belt-and-suspenders for the same reason as the initialWidth/Height
  // clamp above: confirm the window actually landed at-or-above its own
  // minimum after construction (some display/DPI configurations clamp the
  // requested size during creation before `minWidth`/`minHeight` get a say)
  // and force it back up if not.
  {
    const b = mainWindow.getBounds();
    const needW = Math.max(b.width, min.width);
    const needH = Math.max(b.height, min.height);
    if (needW !== b.width || needH !== b.height) {
      mainWindow.setBounds({ ...b, width: needW, height: needH });
    }
    if (process.env.FAZE_DEBUG) {
      process.stderr.write(`[win] requested=${initialWidth}x${initialHeight} min=${JSON.stringify(min)} bounds-before-clamp=${JSON.stringify(b)} bounds-after=${JSON.stringify(mainWindow.getBounds())}\n`);
    }
  }

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
  mainWindow.once('ready-to-show', () => {
    if (suppressInitialShow) {
      suppressInitialShow = false;
      return;
    }
    mainWindow?.show();
  });

  // Forward renderer console + lifecycle failures to main stderr so we can
  // see them in --enable-logging output. Only enabled when FAZE_DEBUG=1.
  if (process.env.FAZE_DEBUG) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
      const lvl = ['V', 'I', 'W', 'E'][level] ?? `${level}`;
      process.stderr.write(`[rend:${lvl}] ${src}:${line} ${message}\n`);
    });
    mainWindow.webContents.on('render-process-gone', (_e, d) => {
      process.stderr.write(`[rend:gone] reason=${d.reason} ec=${d.exitCode}\n`);
    });
    mainWindow.webContents.on('did-fail-load', (_e, c, d, u) => {
      process.stderr.write(`[rend:fail-load] ${c} ${d} url=${u}\n`);
    });
    mainWindow.webContents.on('preload-error', (_e, p, e) => {
      process.stderr.write(`[rend:preload-err] ${p} ${e?.message ?? e}\n`);
    });
  }

  // Closing the window hides it (tray keeps the app alive). Real quit is
  // triggered from the tray menu's Quit item, before which isQuitting flips
  // to true so this close handler doesn't intercept.
  mainWindow.on('close', (e) => {
    if (recreating) return;
    if (!(app as unknown as { isQuitting?: boolean }).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    if (appBarOwner() === mainWindow) removeAppBar();
    mainWindow = null;
  });

  // Magnetic edge snap. Windows emits `moved` when the drag ends, so this
  // reads as "let go near the top of the screen and it clicks into place".
  // It also releases an appbar reservation if the window is dragged out of the
  // dock — see handleWindowMoved().
  mainWindow.on('moved', () => handleWindowMoved(mainWindow));
  mainWindow.on('resized', () => reapplyOnResize(mainWindow));

  const pushWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;

    // Same reasoning as createWindow() above — always the 'full' floor.
    mainWindow.setMinimumSize(LAYOUT_MIN_SIZE.full.width, LAYOUT_MIN_SIZE.full.height);

    mainWindow.webContents.send(IpcChannel.windowState, {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
    });
  };
  mainWindow.on('maximize', pushWindowState);
  mainWindow.on('unmaximize', pushWindowState);
  mainWindow.on('focus', pushWindowState);
  mainWindow.on('blur', pushWindowState);
  mainWindow.on('moved', () => {
    handleWindowMoved(mainWindow);
    pushWindowState();
  });
  mainWindow.on('resized', () => {
    reapplyOnResize(mainWindow);
    pushWindowState();
  });

  // Apply initial always-on-top flag.
  try { mainWindow.setAlwaysOnTop(readSettings().alwaysOnTop, 'floating'); }
  catch { /* ignore on platforms that don't support the floating level */ }
}

/**
 * Electron can't toggle a window's frame after creation, so switching between
 * the OS title bar and our own means building a fresh window at the same
 * bounds. The renderer reloads; an in-progress capture does not survive, which
 * is why the settings UI says so.
 */
function recreateWindow() {
  const old = mainWindow;
  const bounds = old && !old.isDestroyed() ? old.getBounds() : undefined;
  recreating = true;
  try {
    if (old && !old.isDestroyed()) old.destroy();
  } finally {
    recreating = false;
  }
  createWindow(bounds);
}

/**
 * Everything that has to happen after settings are written, from wherever:
 * the settings modal, the tray menu, or the title bar's pin button.
 */
function handleSettingsChanged(s: AppSettings) {
  applyHotkey(s.hotkey);
  applyPopoutWindowSwap(s);
  // Apply always-on-top; the tray module has direct refs to the current
  // window/settings so it can rebuild itself when notified.
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.setAlwaysOnTop(s.alwaysOnTop, 'floating'); }
    catch { /* ignore */ }
  }
  applyPopoutSettings();
  // Mirror the new settings into every window so the pop-out picks up
  // theme/visualizer changes made in the main window and vice-versa.
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.settingsChanged, s);
  }
  // Deferred: this runs inside the settings:set IPC handler, and tearing the
  // sender's window down mid-call is a good way to lose the reply channel.
  if (s.titleBarMode !== builtTitleBarMode) setImmediate(recreateWindow);
}

/**
 * Popping the visualizer out should *move* the app into that window, not add a
 * second one — so the main window hides while the pop-out is up and comes back
 * when it closes.
 *
 * Only transitions of `popoutOpen` act, because this runs on every settings
 * write: without the guard, changing the theme while popped out would yank a
 * main window the user had deliberately brought back via the tray.
 *
 * The main window is only hidden, never closed. It keeps running the capture,
 * the rolling buffer and the frame pump that feeds the pop-out (which is why
 * `backgroundThrottling` is off), and Show in the tray menu always gets it back.
 */
function applyPopoutWindowSwap(s: AppSettings) {
  if (s.popoutOpen === lastPopoutOpen) return;
  lastPopoutOpen = s.popoutOpen;
  if (!s.hideMainWhenPopped) return;
  const w = mainWindow;
  if (!w || w.isDestroyed()) return;
  if (s.popoutOpen) {
    w.hide();
  } else {
    w.show();
    w.focus();
  }
}

/** The pop-out was closed by its own ✕ (or by us) — persist and tell the UI. */
function onPopoutClosed() {
  handleSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: false }));
  const w = mainWindow;
  if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.popoutState, { open: false });
}

function broadcast(event: RecorderEvent) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IpcChannel.recordingEvent, event);
  }
}

function applyHotkey(hotkey: string) {
  hotkeyMgr.register(hotkey, () => {
    broadcast({ type: 'hotkey-pressed' });
  });
}

function init() {
  // ----- Single-instance lock ----------------------------------------------
  // A second launch focuses the existing window instead of opening a new one.
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    const w = mainWindow;
    if (!w || w.isDestroyed()) return;
    if (w.isMinimized()) w.restore();
    if (!w.isVisible()) w.show();
    w.focus();
  });

  // A reservation that outlives its window leaves the user with a dead strip
  // of desktop they can't reclaim without logging out, so this is wired before
  // anything can register one.
  wireAppBarTeardown(app);

  app.whenReady().then(() => {
    // If the last run died holding a reservation, the desktop is still short of
    // that space. Reclaim before anything can register a new one.
    reclaimStaleAppBar();

    // The shell notifies appbars of layout changes through a window message
    // Electron doesn't dispatch, so these stand in for ABN_POSCHANGED.
    screen.on('display-metrics-changed', reapplyAppBar);
    screen.on('display-added', reapplyAppBar);
    screen.on('display-removed', reapplyAppBar);

    registerIpc({
      getWindow: () => mainWindow,
      onSettingsChanged: handleSettingsChanged,
      getCurrentHotkey: () => hotkeyMgr.accel(),
      recreateWindow,
    });

    const initial = readSettings();
    applyHotkey(initial.hotkey);
    lastPopoutOpen = initial.popoutOpen;
    // Relaunching straight into pop-out mode: skip the main window's first
    // show entirely rather than showing then hiding it.
    suppressInitialShow = initial.popoutOpen && initial.hideMainWhenPopped;

    createWindow();

    // Initialise the tray after both window and ipc are ready so the menu
    // can call back into both safely.
    initTray(
      () => mainWindow,
      () => readSettings(),
      (patch) => {
        // Route tray writes through the same path as the settings modal so
        // the renderer sees them (layout, pop-out, always-on-top…).
        const merged = writeSettings({ ...readSettings(), ...patch });
        handleSettingsChanged(merged);
        return merged;
      },
      onPopoutClosed,
    );

    if (initial.popoutOpen) createPopout(onPopoutClosed);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('before-quit', () => {
    // Allow our explicit Quit menu item to actually tear down the window.
    (app as unknown as { isQuitting?: boolean }).isQuitting = true;
    hotkeyMgr.unregister();
    destroyTray();
    if (getPopout()) destroyPopout();
  });

  app.on('window-all-closed', () => {
    hotkeyMgr.unregister();
    // Don't quit when the window is just hidden via the tray (close handler
    // hides; tray menu's Quit calls app.quit()).
  });
}

init();

