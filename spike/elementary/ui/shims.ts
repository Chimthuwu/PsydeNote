// Electron `window.api` shim. The reused components are almost entirely
// Electron-free — the ONLY touchpoint in the P7a set is
// VisualizerBoard.startDragExportPrepared() (history-mode drag export, which
// is meaningless in a plugin). Stub just enough that nothing throws.
//
// If more of window.api creeps in as later components are pulled in, add
// no-op stubs here rather than editing src/renderer.

type AnyFn = (...args: unknown[]) => unknown;

const noop: AnyFn = () => undefined;
const asyncNoop: AnyFn = () => Promise.resolve(undefined);

// A Proxy so any `window.api.whatever(...)` resolves to a no-op (sync or
// promise) instead of a TypeError, without us enumerating the whole surface.
const apiStub = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then') return undefined; // don't look thenable
      if (String(prop).startsWith('get') || String(prop).startsWith('list')) return asyncNoop;
      return noop;
    },
  },
);

const w = window as unknown as { api?: unknown };
if (typeof window !== 'undefined' && !w.api) {
  w.api = apiStub;
}

// ---------------------------------------------------------------------------
// Forward errors + console.error/warn to native so a DAW freeze leaves a
// trace (WebView2 in a reparented plugin window has no DevTools). C++ writes
// these to %TEMP%/faez-ui.log. Temporary diagnostic (§73).
// ---------------------------------------------------------------------------
function toNative(kind: string, msg: string) {
  const fn = (window as unknown as { __postNativeMessage__?: (...a: unknown[]) => unknown })
    .__postNativeMessage__;
  try {
    if (typeof fn === 'function') fn('log', kind, String(msg).slice(0, 800)); // spread — see bridge.ts
  } catch {
    /* ignore */
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) =>
    toNative('error', `${e.message} @ ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) =>
    toNative('reject', String((e as PromiseRejectionEvent).reason)));
  const origErr = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...a: unknown[]) => { toNative('console.error', a.join(' ')); origErr(...a); };
  console.warn = (...a: unknown[]) => { toNative('console.warn', a.join(' ')); origWarn(...a); };
  toNative('boot', `ui script running; document.readyState=${document.readyState}`);
}

// ---------------------------------------------------------------------------
// 2D canvas is OPT-IN in the plugin webview (todo.md §73 P7c).
//
// The reused VisualizerBoard (one per operator) and WaveformThumb each run an
// unconditional 60fps requestAnimationFrame repaint loop + a ResizeObserver
// that writes canvas.width. Cheap and self-throttling in a browser tab; in a
// WebView2 reparented into a DAW's window they don't throttle and the RO fires
// through the embed reflow — hard-froze Bitwig + FL on editor open. Those
// components bail on their first line when `getContext('2d')` is null, so we
// return null for them and let Faze's own Scope component (which sets
// `data-allow-2d`, drives ONE throttled loop and has no ResizeObserver) draw.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext: (id: string, ...rest: unknown[]) => unknown;
  };
  const native = proto.getContext;
  proto.getContext = function patched(this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
    if (id === '2d' && !this.hasAttribute('data-allow-2d')) return null;
    return native.call(this, id, ...rest);
  };
}

// rAF throttle — belt-and-braces for any animation loop that slips in.
//
// Every canvas loop here re-registers its callback each frame, so the old
// implementation (one global `lastTick`, each call pushed to the *end* of the
// next frame window) serialised N loops into N× slowdown — with the ~7
// canvases on screen the effective repaint rate collapsed to ~2 fps ("hella
// laggy"). Instead: collect every rAF callback for the current window and run
// them together on ONE timer tick at a global fps cap. Also patch
// `cancelAnimationFrame` to match — the old shim returned a setTimeout id that
// the native cancel couldn't clear, so unmounted components (LFO graph, FxViz)
// leaked their loops forever.
if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
  const MIN_FRAME_MS = 1000 / 58; // ~60fps (was 30: halved every canvas incl. the scopes; the batch pump already fixed the N-loops-serialised collapse)
  const nativeRaf = window.requestAnimationFrame.bind(window);
  const nativeCancel: (h: number) => void =
    typeof window.cancelAnimationFrame === 'function'
      ? window.cancelAnimationFrame.bind(window)
      : () => undefined;

  // One shared vsync pump drains ALL rAF callbacks together, capped at
  // MIN_FRAME_MS. Every callback here re-registers itself each frame, so
  // draining them one-per-tick (the old shim) made effective fps = cap / N.
  const pending = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  let pumping = false;
  let lastFrame = 0;

  const pump = (t: number) => {
    if (t - lastFrame >= MIN_FRAME_MS && pending.size) {
      lastFrame = t;
      const batch = [...pending.values()];
      pending.clear();
      for (const cb of batch) {
        try { cb(t); } catch { /* one bad loop must not kill the rest */ }
      }
    }
    if (pending.size) nativeRaf(pump);
    else pumping = false;
  };

  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    const id = nextId;
    nextId += 1;
    pending.set(id, cb);
    if (!pumping) { pumping = true; nativeRaf(pump); }
    return id;
  };
  window.cancelAnimationFrame = (h: number) => {
    if (!pending.delete(h)) nativeCancel(h);
  };
}

export {};
