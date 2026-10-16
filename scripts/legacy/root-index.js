"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const node_path_1 = __importDefault(require("node:path"));
const settings_1 = require("./settings");
const hotkeys_1 = require("./hotkeys");
const types_1 = require("../shared/types");
const ipc_1 = require("./ipc");
const tray_1 = require("./tray");
const isDev = process.env.NODE_ENV === 'development';
let mainWindow = null;
const hotkeyMgr = new hotkeys_1.HotkeyManager();
function createWindow() {
    mainWindow = new electron_1.BrowserWindow({
        width: 1100,
        height: 760,
        minWidth: 720,
        minHeight: 540,
        title: 'Faze',
        backgroundColor: '#070a1c',
        autoHideMenuBar: true,
        show: false, // show after ready-to-show
        icon: (0, tray_1.makeAppIcon)(),
        webPreferences: {
            preload: node_path_1.default.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
        },
    });
    electron_1.Menu.setApplicationMenu(null);
    if (isDev) {
        mainWindow.loadURL('http://localhost:5173');
        mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
    else {
        mainWindow.loadFile(node_path_1.default.join(__dirname, '../renderer/index.html'));
    }
    mainWindow.once('ready-to-show', () => {
        mainWindow?.show();
    });
    // TEMP: forward renderer console -> main stderr so we can read it from logs.
    if (!isDev) {
        mainWindow.webContents.on('console-message', (_e, level, message, line, src) => {
            const lvl = ['VERB', 'INFO', 'WARN', 'ERR '][level] ?? 'L?  ';
            process.stderr.write(`[renderer:${lvl}] ${src}:${line} ${message}\n`);
        });
        mainWindow.webContents.on('render-process-gone', (_e, details) => {
            process.stderr.write(`[renderer] GONE reason=${details.reason} exitCode=${details.exitCode}\n`);
        });
        mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
            process.stderr.write(`[renderer] FAILED LOAD ${code} ${desc} url=${url}\n`);
        });
        mainWindow.webContents.on('preload-error', (_e, preloadPath, err) => {
            process.stderr.write(`[renderer] PRELOAD ERROR ${preloadPath}: ${err?.message ?? err}\n`);
        });
    }
    // Closing the window hides it (tray keeps the app alive). Real quit is
    // triggered from the tray menu's Quit item, before which isQuitting flips
    // to true so this close handler doesn't intercept.
    mainWindow.on('close', (e) => {
        if (!electron_1.app.isQuitting) {
            e.preventDefault();
            mainWindow?.hide();
        }
    });
    mainWindow.on('closed', () => {
        mainWindow = null;
    });
    // Apply initial always-on-top flag.
    try {
        mainWindow.setAlwaysOnTop((0, settings_1.readSettings)().alwaysOnTop, 'floating');
    }
    catch { /* ignore on platforms that don't support the floating level */ }
}
function broadcast(event) {
    for (const win of electron_1.BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed())
            win.webContents.send(types_1.IpcChannel.recordingEvent, event);
    }
}
function applyHotkey(hotkey) {
    hotkeyMgr.register(hotkey, () => {
        broadcast({ type: 'hotkey-pressed' });
    });
}
function init() {
    // ----- Single-instance lock ----------------------------------------------
    // A second launch focuses the existing window instead of opening a new one.
    const gotLock = electron_1.app.requestSingleInstanceLock();
    if (!gotLock) {
        electron_1.app.quit();
        return;
    }
    electron_1.app.on('second-instance', () => {
        const w = mainWindow;
        if (!w || w.isDestroyed())
            return;
        if (w.isMinimized())
            w.restore();
        if (!w.isVisible())
            w.show();
        w.focus();
    });
    electron_1.app.whenReady().then(() => {
        (0, ipc_1.registerIpc)({
            getWindow: () => mainWindow,
            onSettingsChanged: (s) => {
                applyHotkey(s.hotkey);
                // Apply always-on-top; the tray module has direct refs to the
                // current window/settings so it can rebuild itself when notified.
                if (mainWindow && !mainWindow.isDestroyed()) {
                    try {
                        mainWindow.setAlwaysOnTop(s.alwaysOnTop, 'floating');
                    }
                    catch { /* ignore */ }
                }
            },
            getCurrentHotkey: () => hotkeyMgr.accel(),
        });
        const initial = (0, settings_1.readSettings)();
        applyHotkey(initial.hotkey);
        createWindow();
        // Initialise the tray after both window and ipc are ready so the menu
        // can call back into both safely.
        (0, tray_1.initTray)(() => mainWindow, () => (0, settings_1.readSettings)(), (patch) => (0, settings_1.writeSettings)({ ...(0, settings_1.readSettings)(), ...patch }));
        electron_1.app.on('activate', () => {
            if (electron_1.BrowserWindow.getAllWindows().length === 0)
                createWindow();
        });
    });
    electron_1.app.on('before-quit', () => {
        // Allow our explicit Quit menu item to actually tear down the window.
        electron_1.app.isQuitting = true;
        hotkeyMgr.unregister();
        (0, tray_1.destroyTray)();
    });
    electron_1.app.on('window-all-closed', () => {
        hotkeyMgr.unregister();
        // Don't quit when the window is just hidden via the tray (close handler
        // hides; tray menu's Quit calls app.quit()).
    });
}
init();
//# sourceMappingURL=index.js.map