import { contextBridge, ipcRenderer } from 'electron';
import {
  AppSettings,
  CaptureSource,
  IpcChannel,
  LoopbackDevice,
  LoopbackEvent,
  PresetResult,
  RecorderEvent,
  SaveResult,
  SnapTarget,
  SynthPreset,
  SynthSettings,
  VizCommand,
  VizFrame,
  VizState,
  WindowAction,
} from '../shared/types';

const api = {
  getSettings(): Promise<AppSettings> {
    return ipcRenderer.invoke(IpcChannel.settingsGet);
  },
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    return ipcRenderer.invoke(IpcChannel.settingsSet, patch);
  },
  listPresets(): Promise<SynthPreset[]> {
    return ipcRenderer.invoke(IpcChannel.presetsList);
  },
  savePreset(name: string, synth: SynthSettings): Promise<PresetResult> {
    return ipcRenderer.invoke(IpcChannel.presetsSave, { name, synth });
  },
  deletePreset(name: string): Promise<PresetResult> {
    return ipcRenderer.invoke(IpcChannel.presetsDelete, { name });
  },
  listSources(): Promise<CaptureSource[]> {
    return ipcRenderer.invoke(IpcChannel.sourcesList);
  },
  pickFolder(): Promise<string | null> {
    return ipcRenderer.invoke(IpcChannel.folderPick);
  },
  saveRecording(args: { folder: string; bytes: Uint8Array; durationSec?: number; deviceName?: string }): Promise<SaveResult> {
    return ipcRenderer.invoke(IpcChannel.saveRecording, args);
  },
  startDragExport(args: { bytes: Uint8Array; deviceName?: string }): void {
    ipcRenderer.send(IpcChannel.dragExport, args);
  },
  prepareDragFile(args: { bytes: Uint8Array }): void {
    ipcRenderer.send(IpcChannel.dragPrepare, args);
  },
  startDragExportPrepared(): void {
    ipcRenderer.send(IpcChannel.dragExportPrepared);
  },
  startDragExportByProxy(bounds: [number, number]): void {
    ipcRenderer.send(IpcChannel.dragExportProxy, { bounds });
  },
  onRequestDragExport(handler: (bounds: [number, number]) => void): () => void {
    const listener = (_e: unknown, args: { bounds: [number, number] }) => handler(args.bounds);
    ipcRenderer.on(IpcChannel.requestDragExport, listener);
    return () => ipcRenderer.removeListener(IpcChannel.requestDragExport, listener);
  },
  onRecorderEvent(handler: (e: RecorderEvent) => void): () => void {
    const listener = (_e: unknown, ev: RecorderEvent) => handler(ev);
    ipcRenderer.on(IpcChannel.recordingEvent, listener);
    return () => ipcRenderer.removeListener(IpcChannel.recordingEvent, listener);
  },
  setAlwaysOnTop(enabled: boolean): void {
    ipcRenderer.invoke(IpcChannel.windowSetAlwaysOnTop, { enabled });
  },
  setTrayCapturing(capturing: boolean): void {
    ipcRenderer.invoke(IpcChannel.traySetCapturing, { capturing });
  },
  onOpenSettingsRequest(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on(IpcChannel.openSettings, listener);
    return () => ipcRenderer.removeListener(IpcChannel.openSettings, listener);
  },
  /** Settings saved anywhere (any window, or the tray menu). */
  onSettingsChanged(handler: (s: AppSettings) => void): () => void {
    const listener = (_e: unknown, s: AppSettings) => handler(s);
    ipcRenderer.on(IpcChannel.settingsChanged, listener);
    return () => ipcRenderer.removeListener(IpcChannel.settingsChanged, listener);
  },

  // ------- Window chrome / geometry -------------------------------------------

  /** Minimise / maximise / hide / close the window that called this. */
  windowControl(action: WindowAction): void {
    void ipcRenderer.invoke(IpcChannel.windowControl, { action });
  },
  /** Park the window against an edge of its current display. */
  snapWindow(target: SnapTarget): void {
    void ipcRenderer.invoke(IpcChannel.windowSnap, { target });
  },
  /**
   * Grow the window to `height` px so a popover taller than it stays visible;
   * pass null to snap back. Used by the bar layout's device dropdown.
   */
  tempExpandWindow(height: number | null): void {
    void ipcRenderer.invoke(IpcChannel.windowTempExpand, { height });
  },
  /**
   * Pop the native right-click quick menu (device, visualizer, layout…) at the
   * cursor. Native rather than in-DOM so it isn't clipped by a `bar`-layout
   * window that's only 38px tall.
   */
  showContextMenu(): void {
    void ipcRenderer.invoke(IpcChannel.contextMenu);
  },
  onWindowState(handler: (s: { maximized: boolean; focused: boolean }) => void): () => void {
    const listener = (_e: unknown, s: { maximized: boolean; focused: boolean }) => handler(s);
    ipcRenderer.on(IpcChannel.windowState, listener);
    return () => ipcRenderer.removeListener(IpcChannel.windowState, listener);
  },

  // ------- Pop-out visualizer --------------------------------------------------

  togglePopout(open?: boolean): Promise<{ open: boolean }> {
    return ipcRenderer.invoke(IpcChannel.popoutToggle, { open });
  },
  onPopoutState(handler: (s: { open: boolean }) => void): () => void {
    const listener = (_e: unknown, s: { open: boolean }) => handler(s);
    ipcRenderer.on(IpcChannel.popoutState, listener);
    return () => ipcRenderer.removeListener(IpcChannel.popoutState, listener);
  },
  /** Main window → pop-out: one analyser frame. Fire-and-forget, ~30/s. */
  sendVizFrame(frame: VizFrame): void {
    ipcRenderer.send(IpcChannel.vizFrame, frame);
  },
  /** Main window → pop-out: capture/buffer/theme state, on change only. */
  sendVizState(state: VizState): void {
    ipcRenderer.send(IpcChannel.vizState, state);
  },
  onVizFrame(handler: (f: VizFrame) => void): () => void {
    const listener = (_e: unknown, f: VizFrame) => handler(f);
    ipcRenderer.on(IpcChannel.vizFrame, listener);
    return () => ipcRenderer.removeListener(IpcChannel.vizFrame, listener);
  },
  onVizState(handler: (s: VizState) => void): () => void {
    const listener = (_e: unknown, s: VizState) => handler(s);
    ipcRenderer.on(IpcChannel.vizState, listener);
    return () => ipcRenderer.removeListener(IpcChannel.vizState, listener);
  },
  sendVizHistory(state: any): void {
    ipcRenderer.send(IpcChannel.vizHistory, state);
  },
  onVizHistory(handler: (s: any) => void): () => void {
    const listener = (_e: unknown, s: any) => handler(s);
    ipcRenderer.on(IpcChannel.vizHistory, listener);
    return () => ipcRenderer.removeListener(IpcChannel.vizHistory, listener);
  },
  /** Pop-out → main window: a transport command. */
  sendVizCommand(cmd: VizCommand): void {
    ipcRenderer.send(IpcChannel.vizCommand, cmd);
  },
  onVizCommand(handler: (c: VizCommand) => void): () => void {
    const listener = (_e: unknown, c: VizCommand) => handler(c);
    ipcRenderer.on(IpcChannel.vizCommand, listener);
    return () => ipcRenderer.removeListener(IpcChannel.vizCommand, listener);
  },

  // ------- WASAPI loopback ----------------------------------------------------

  listLoopbackDevices(): Promise<LoopbackDevice[]> {
    return ipcRenderer.invoke(IpcChannel.loopbackList);
  },
  startLoopback(args: { deviceId: string; deviceName: string; sampleRate?: number }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke(IpcChannel.loopbackStart, args);
  },
  stopLoopback(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke(IpcChannel.loopbackStop);
  },
  /**
   * Subscribe to live PCM sample frames (Uint8Array of 32-bit float stereo
   * samples, little-endian). Returns an unsubscribe function.
   */
  onLoopbackSamples(handler: (u8: Uint8Array) => void): () => void {
    const wrap = (_e: unknown, payload: Uint8Array) => handler(payload);
    ipcRenderer.on(IpcChannel.loopbackSamples, wrap);
    return () => ipcRenderer.removeListener(IpcChannel.loopbackSamples, wrap);
  },
  onLoopbackEvent(handler: (e: LoopbackEvent) => void): () => void {
    const wrap = (_e: unknown, ev: LoopbackEvent) => handler(ev);
    ipcRenderer.on(IpcChannel.loopbackEvent, wrap);
    return () => ipcRenderer.removeListener(IpcChannel.loopbackEvent, wrap);
  },

  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);

export type Api = typeof api;
