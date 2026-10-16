import { app, ipcMain, dialog, BrowserWindow, desktopCapturer, Menu, MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import {
  AppSettings,
  CaptureSource,
  IpcChannel,
  LoopbackDevice,
  PresetResult,
  SaveResult,
  SnapTarget,
  SynthPreset,
  SynthSettings,
  VisualizerMode,
  WindowAction,
} from '../shared/types';
import { deletePreset, listPresets, savePreset } from './presets';
import { performWindowAction, snapWindow, tempExpand } from './window-controls';
import { removeAppBar } from './appbar';
import {
  createPopout,
  destroyPopout,
  forwardVizFrame,
  forwardVizState,
  forwardVizHistory,
  getPopout,
  isPopoutOpen,
} from './popout';
import { readSettings, writeSettings } from './settings';
import { saveWebm } from './save';
import {
  listLoopbackDevices,
  loopbackManager,
  resolveHelperPath,
} from './wasapi';
import {
  notifySaveCompleted,
  setCapturingState as setTrayCapturingState,
} from './tray';

let preparedDragFilePath: string | null = null;

export interface IpcContext {
  getWindow: () => BrowserWindow | null;
  onSettingsChanged: (s: AppSettings) => void;
  getCurrentHotkey: () => string | null;
  /** Rebuild the main window — the only way to change its frame at runtime. */
  recreateWindow: () => void;
}

export function registerIpc(ctx: IpcContext) {
  ipcMain.handle(IpcChannel.settingsGet, () => readSettings());

  // ------- Presets (todo.md §50) ------------------------------------------
  // Synth patch library, stored separately from AppSettings in
  // faze-presets.json. Load is renderer-side (apply the returned synth
  // block through the normal settings pipeline); main only stores/retrieves.
  ipcMain.handle(IpcChannel.presetsList, (): SynthPreset[] => listPresets());

  ipcMain.handle(
    IpcChannel.presetsSave,
    (_e, args: { name: string; synth: SynthSettings }): PresetResult =>
      savePreset(args.name, args.synth),
  );

  ipcMain.handle(
    IpcChannel.presetsDelete,
    (_e, args: { name: string }): PresetResult => deletePreset(args.name),
  );

  ipcMain.handle(
    IpcChannel.settingsSet,
    (_e, next: Partial<AppSettings>): AppSettings => {
      const merged = writeSettings({ ...readSettings(), ...next });
      ctx.onSettingsChanged(merged);
      return merged;
    },
  );

  ipcMain.handle(IpcChannel.sourcesList, async (): Promise<CaptureSource[]> => {
    // Windows' loopback audio mixer only attaches to screen captures, and
    // asking for audio off a window id kills the renderer outright rather than
    // failing softly — so don't offer window sources there at all. A screen
    // capture already carries every application's audio.
    const types: ('screen' | 'window')[] =
      process.platform === 'win32' ? ['screen'] : ['screen', 'window'];
    const sources = await desktopCapturer.getSources({
      types,
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 },
    });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
    }));
  });

  ipcMain.handle(IpcChannel.folderPick, async (): Promise<string | null> => {
    const win = ctx.getWindow();
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Select recording save folder',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  ipcMain.handle(
    IpcChannel.saveRecording,
    async (_e, args: { folder: string; bytes: Uint8Array; durationSec?: number; deviceName?: string }): Promise<SaveResult> => {
      try {
        if (!args.folder) return { ok: false, error: 'No save folder configured' };
        const settings = readSettings();
        const r = await saveWebm({
          folder: args.folder,
          bytes: args.bytes,
          template: settings.fileNameTemplate,
          settings,
          deviceName: args.deviceName,
        });
        // Notify the tray so the recent-saves menu + tooltip update and (on
        // Windows) a balloon pops up showing the new filename.
        notifySaveCompleted({ fileName: r.fileName, fullPath: r.path });
        return { ok: true, path: r.path, bytes: r.bytes, fileName: r.fileName } satisfies SaveResult;
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.on(
    IpcChannel.dragExport,
    (e, args: { bytes: Uint8Array; deviceName?: string }) => {
      try {
        const now = new Date();
        const tempName = `faze_snippet_${now.getHours()}${now.getMinutes()}${now.getSeconds()}.webm`;
        const tempPath = path.join(app.getPath('temp'), tempName);
        fs.writeFileSync(tempPath, args.bytes);
        
        const { nativeImage } = require('electron');
        // Windows might reject startDrag if the icon is completely empty (0x0).
        // A 1x1 transparent pixel prevents the OS from aborting the drag.
        const transparent1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAFElEQVR42mNkYPhfzwAEjBhzgAAASxID9T25tUQAAAAASUVORK5CYII=';
        e.sender.startDrag({
          file: tempPath,
          icon: nativeImage.createFromDataURL(transparent1x1),
        });
      } catch (err) {
        console.error('Drag export failed:', err);
      }
    }
  );

  ipcMain.on(
    IpcChannel.dragPrepare,
    (e, args: { bytes: Uint8Array }) => {
      try {
        const now = new Date();
        const tempName = `faze_snippet_${now.getHours()}${now.getMinutes()}${now.getSeconds()}.webm`;
        const tempPath = path.join(app.getPath('temp'), tempName);
        fs.writeFileSync(tempPath, args.bytes);
        preparedDragFilePath = tempPath;
      } catch (err) {
        console.error('Drag preparation failed:', err);
      }
    }
  );

  ipcMain.on(
    IpcChannel.dragExportPrepared,
    (e) => {
      try {
        if (!preparedDragFilePath || !fs.existsSync(preparedDragFilePath)) {
          console.error('No prepared drag file found');
          return;
        }
        const { nativeImage } = require('electron');
        const transparent1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAFElEQVR42mNkYPhfzwAEjBhzgAAASxID9T25tUQAAAAASUVORK5CYII=';
        e.sender.startDrag({
          file: preparedDragFilePath,
          icon: nativeImage.createFromDataURL(transparent1x1),
        });
      } catch (err) {
        console.error('Drag export prepared failed:', err);
      }
    }
  );

  ipcMain.on(
    IpcChannel.dragExportProxy,
    (e, args: { bounds: [number, number] }) => {
      // Popout window requested a drag. We ask the main window to perform the export.
      const mainWin = ctx.getWindow();
      if (mainWin && !mainWin.isDestroyed()) {
        mainWin.webContents.send(IpcChannel.requestDragExport, args);
      }
    }
  );

  // ------- WASAPI loopback helpers ---------------------------------------------------------

  ipcMain.handle(IpcChannel.loopbackList, async (): Promise<LoopbackDevice[]> => {
    try {
      return await listLoopbackDevices();
    } catch (err) {
      // Surface a structured error so the UI can fall back to desktop mode.
      console.warn('[loopback:list] failed:', err);
      return [];
    }
  });

  ipcMain.handle(
    IpcChannel.loopbackStart,
    async (_e, args: { deviceId: string; deviceName: string; sampleRate?: number }): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Resolve helper path early so we fail fast if it's missing.
        resolveHelperPath();
        const device: LoopbackDevice = {
          id: args.deviceId,
          name: args.deviceName,
          isDefault: false,
          sampleRate: args.sampleRate ?? 48000,
          channelCount: 2,
        };
        await loopbackManager.start(device, args.sampleRate ?? 48000, ctx.getWindow);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );

  ipcMain.handle(IpcChannel.loopbackStop, async () => {
    await loopbackManager.stop();
    return { ok: true };
  });

  // ------- Window controls ---------------------------------------------------

  ipcMain.handle(
    IpcChannel.windowSetAlwaysOnTop,
    (_e, args: { enabled: boolean }): void => {
      const w = ctx.getWindow();
      if (!w || w.isDestroyed()) return;
      try { w.setAlwaysOnTop(args.enabled, 'floating'); } catch { /* ignore */ }
    },
  );

  // The custom title bar's minimise / maximise / close buttons.
  ipcMain.handle(
    IpcChannel.windowControl,
    (e, args: { action: WindowAction }): void => {
      // Route to whichever window asked — the pop-out has its own close button.
      const w = BrowserWindow.fromWebContents(e.sender) ?? ctx.getWindow();
      performWindowAction(w, args.action);
    },
  );

  ipcMain.handle(
    IpcChannel.windowSnap,
    (e, args: { target: SnapTarget }): void => {
      const w = BrowserWindow.fromWebContents(e.sender);
      if (w === ctx.getWindow() && args.target === 'top') {
        if (!isPopoutOpen()) {
          createPopout(() => {
            ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: false }));
          });
          ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: true }));
        }
        setTimeout(() => {
          const popout = getPopout();
          if (popout) snapWindow(popout, 'top');
        }, 100);
        return;
      }

      const targetWin = w ?? ctx.getWindow();
      snapWindow(targetWin, args.target);
    },
  );

  // Temporarily grow the window so a popover taller than it can be seen.
  ipcMain.handle(
    IpcChannel.windowTempExpand,
    (_e, args: { height: number | null }): void => {
      tempExpand(ctx.getWindow(), args.height);
    },
  );

  /**
   * The right-click quick menu.
   *
   * Built natively rather than in the renderer for one hard reason: `bar`
   * layout is a 38px-tall window, and anything the renderer draws is clipped at
   * the window edge. A native menu floats free of the window, so the same menu
   * works whether the app is full-size or a strip docked to the top of a
   * monitor. It's also why the output-device picker no longer has to occupy a
   * permanent row in the UI.
   */
  ipcMain.handle(IpcChannel.contextMenu, async (e): Promise<void> => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? ctx.getWindow();
    if (!win || win.isDestroyed()) return;
    const s = readSettings();

    const apply = (patch: Partial<AppSettings>) => {
      ctx.onSettingsChanged(writeSettings({ ...readSettings(), ...patch }));
    };

    // Only enumerate the backend actually in use — desktopCapturer and the
    // WASAPI helper both cost real time and only one of them can be current.
    let deviceItems: MenuItemConstructorOptions[];
    if (s.captureBackend === 'loopback') {
      let devices: LoopbackDevice[] = [];
      try { devices = await listLoopbackDevices(); } catch { /* helper missing */ }
      deviceItems = devices.length
        ? devices.map((d) => ({
            label: d.isDefault ? `★ ${d.name}` : d.name,
            type: 'radio' as const,
            checked: s.loopbackDeviceId === d.id,
            click: () => apply({ loopbackDeviceId: d.id }),
          }))
        : [{ label: 'No output devices found', enabled: false }];
    } else {
      let sources: CaptureSource[] = [];
      try {
        sources = (
          await desktopCapturer.getSources({
            types: process.platform === 'win32' ? ['screen'] : ['screen', 'window'],
            fetchWindowIcons: false,
            thumbnailSize: { width: 0, height: 0 },
          })
        ).map((x) => ({ id: x.id, name: x.name, kind: 'screen' as const }));
      } catch { /* ignore */ }
      deviceItems = sources.length
        ? sources.map((src) => ({
            label: src.name,
            type: 'radio' as const,
            checked: s.sourceId === src.id,
            click: () => apply({ sourceId: src.id }),
          }))
        : [{ label: 'No sources found', enabled: false }];
    }

    const vizItem = (mode: VisualizerMode, label: string): MenuItemConstructorOptions => ({
      label,
      type: 'radio',
      checked: s.visualizer === mode,
      click: () => apply({ visualizer: mode }),
    });

    const template: MenuItemConstructorOptions[] = [
      { label: s.captureBackend === 'loopback' ? 'Output device' : 'Capture source', enabled: false },
      ...deviceItems,
      { type: 'separator' },
      {
        label: 'Capture backend',
        submenu: [
          {
            label: 'WASAPI loopback (per device)',
            type: 'radio',
            checked: s.captureBackend === 'loopback',
            enabled: process.platform === 'win32',
            click: () => apply({ captureBackend: 'loopback' }),
          },
          {
            label: 'Desktop capture (whole screen)',
            type: 'radio',
            checked: s.captureBackend === 'desktop',
            click: () => apply({ captureBackend: 'desktop' }),
          },
        ],
      },
      { type: 'separator' },
      vizItem('oscilloscope', 'Oscilloscope'),
      vizItem('spectrum', 'Spectrum'),
      vizItem('spectrogram', 'Spectrogram'),
      { type: 'separator' },
      {
        label: 'Theme',
        submenu: (['aurora-ice', 'black-ice', 'graphite'] as const).map((t) => ({
          label: t === 'black-ice' ? 'Black ice' : 'Aurora ice',
          type: 'radio',
          checked: s.theme === t,
          click: () => apply({ theme: t }),
        })),
      },
      { type: 'separator' },
      {
        label: 'Rolling buffer',
        type: 'checkbox',
        checked: s.recordMode === 'rolling',
        click: () => apply({ recordMode: s.recordMode === 'rolling' ? 'traditional' : 'rolling' }),
      },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: s.alwaysOnTop,
        click: () => apply({ alwaysOnTop: !s.alwaysOnTop }),
      },
      {
        label: 'Pop out visualizer',
        type: 'checkbox',
        checked: isPopoutOpen(),
        click: () => {
          const want = !isPopoutOpen();
          if (want) {
            createPopout(() => {
              ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: false }));
            });
          } else {
            destroyPopout();
          }
          apply({ popoutOpen: want });
        },
      },
      { type: 'separator' },
      {
        label: 'Dock to top of screen',
        click: () => {
          if (!isPopoutOpen()) {
            createPopout(() => {
              ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: false }));
            });
            apply({ popoutOpen: true });
          }
          setTimeout(() => {
            const popout = getPopout();
            if (popout) snapWindow(popout, 'top');
          }, 100);
        },
      },
      {
        label: 'Docking reserves screen space',
        type: 'checkbox',
        checked: s.dockReservesSpace,
        enabled: process.platform === 'win32',
        click: () => {
          const next = !s.dockReservesSpace;
          // Turning it off has to hand the desktop back immediately, not at the
          // next undock — the user just said they don't want the strip.
          if (!next) removeAppBar();
          apply({ dockReservesSpace: next });
          if (next) snapWindow(win, 'top');
        },
      },
      {
        label: 'Show device picker in window',
        type: 'checkbox',
        checked: s.showSourcePicker,
        click: () => apply({ showSourcePicker: !s.showSourcePicker }),
      },
      { type: 'separator' },
      {
        label: 'Settings…',
        click: () => {
          const w = ctx.getWindow();
          if (w && !w.isDestroyed()) {
            if (!w.isVisible()) w.show();
            w.focus();
            w.webContents.send(IpcChannel.openSettings);
          }
        },
      },
    ];

    Menu.buildFromTemplate(template).popup({ window: win });
  });

  // ------- Pop-out visualizer ------------------------------------------------

  ipcMain.handle(
    IpcChannel.popoutToggle,
    (_e, args: { open?: boolean } = {}): { open: boolean } => {
      const want = args.open ?? !isPopoutOpen();
      if (want) {
        createPopout(() => {
          // Closed by its own ✕. Same path as an explicit toggle-off so the
          // main window comes back and every window sees the new state.
          ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: false }));
          const w = ctx.getWindow();
          if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.popoutState, { open: false });
        });
      } else {
        destroyPopout();
      }
      // Route through onSettingsChanged rather than writing quietly: main hides
      // or restores the main window off this transition, and the pop-out's own
      // useSettings only learns about it from the settings:changed broadcast.
      ctx.onSettingsChanged(writeSettings({ ...readSettings(), popoutOpen: want }));
      const w = ctx.getWindow();
      if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.popoutState, { open: want });
      return { open: want };
    },
  );

  // Relays. These run at frame rate, so they're `on`/`send` rather than
  // `handle`/`invoke` — no promise per frame, and nothing to await.
  ipcMain.on(IpcChannel.vizFrame, (_e, payload) => forwardVizFrame(payload));
  ipcMain.on(IpcChannel.vizState, (_e, payload) => forwardVizState(payload));
  ipcMain.on(IpcChannel.vizHistory, (_e, payload) => forwardVizHistory(payload));
  ipcMain.on(IpcChannel.vizCommand, (_e, payload) => {
    const w = ctx.getWindow();
    if (w && !w.isDestroyed()) w.webContents.send(IpcChannel.vizCommand, payload);
  });

  // ------- Tray state --------------------------------------------------------

  // Renderer drives the actual recorder, so it pushes capture state to the
  // tray so title/icon/elapsed-time UI can update in real time.
  ipcMain.handle(
    IpcChannel.traySetCapturing,
    (_e, args: { capturing: boolean }): void => {
      setTrayCapturingState(args.capturing);
    },
  );
}
