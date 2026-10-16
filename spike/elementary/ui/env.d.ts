/// <reference types="vite/client" />

// The plugin UI reuses src/renderer components but NOT src/renderer/global.d.ts
// (that pulls the whole Electron preload `Api` surface). The only `window.api`
// touchpoint in the reused set is VisualizerBoard.startDragExportPrepared();
// ui/shims.ts installs a no-op Proxy. Loose ambient type so it compiles.
declare global {
  interface Window {
    api: Record<string, (...args: unknown[]) => unknown>;
  }
}

export {};
