// Native <-> webview bridge (todo.md §73, P7a).
//
// choc (WebViewEditor.cpp) injects `window.__postNativeMessage__`. Protocol:
//   UI -> native:  ['ready']
//                  ['setParameterValue', { paramId, value }]   (value in the
//                     param's REAL units — C++ converts to normalised)
//                  ['midiNote', midi, on(0|1), velocity]        (P7a: UI piano)
//   native -> UI:   window.__receiveStateChange__(jsonString)   flat params +
//                     v{i}_gate / v{i}_freq / v{i}_vel + sampleRate
//                  window.__receiveError__({ name, message })
//
// All outbound calls are DEFERRED to a macrotask and param writes are
// COALESCED (latest value per id per flush). Native calls dispatchStateChange
// synchronously from the 'ready' bind callback and again on every param
// change; if setParam fired synchronously from inside __receiveStateChange__
// (React commit -> onChange) it would re-enter native mid-callback and, under
// a render storm, flood the message thread (froze Bitwig + FL — §73).
//
// In a plain browser (npm run dev:ui) __postNativeMessage__ is absent — the
// bridge degrades to console logging so the UI still renders for layout work.

type NativeMessage = [string, ...unknown[]];

// choc's bind wrapper does `params: Array.prototype.slice.call(arguments)`, so
// the native lambda receives our args SPREAD (args[0]="setParameterValue",
// args[1]=payload, …) — exactly what WebViewEditor.cpp reads. Passing a single
// array would land the whole array in args[0] and getString() would fail
// silently. (todo.md §73 — this is why the first builds' knobs/notes/`ready`
// never reached native.)
const rawPost = (msg: NativeMessage): void => {
  const fn = (window as unknown as { __postNativeMessage__?: (...a: unknown[]) => unknown })
    .__postNativeMessage__;
  if (typeof fn === 'function') fn(...msg);
  else if (import.meta.env.DEV) console.debug('[bridge:no-native]', msg);
};

// Deferred, coalesced outbound queue.
const pendingParams = new Map<string, number>();
const pendingOther: NativeMessage[] = [];
let flushScheduled = false;

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  setTimeout(flush, 0);
}

function flush(): void {
  flushScheduled = false;
  for (const msg of pendingOther.splice(0)) rawPost(msg);
  if (pendingParams.size) {
    const params = [...pendingParams.entries()];
    pendingParams.clear();
    for (const [paramId, value] of params) {
      rawPost(['setParameterValue', { paramId, value }]);
    }
  }
}

let standalone = false;
const standaloneListeners = new Set<() => void>();

export const bridge = {
  ready(): void {
    pendingOther.push(['ready']);
    scheduleFlush();
  },

  setParam(paramId: string, value: number): void {
    if (!Number.isFinite(value)) return;
    pendingParams.set(paramId, value); // last write wins per flush
    scheduleFlush();
  },

  /** UI on-screen piano — inject a note into the plugin's voice pool. */
  midiNote(midi: number, on: boolean, velocity = 0.8): void {
    pendingOther.push(['midiNote', midi, on ? 1 : 0, velocity]);
    scheduleFlush();
  },

  /** Sampler file-load (todo.md §114) — opens a native file picker for
   *  operator `opIndex`; a successful load pushes a fresh state (new
   *  op{k}_samplepath/_sampleversion/_sampleduration/_samplepeaks). */
  pickSampleFile(opIndex: number): void {
    pendingOther.push(['pickSampleFile', opIndex]);
    scheduleFlush();
  },
  /** Clears whatever sample is loaded for operator `opIndex`. */
  clearSampleFile(opIndex: number): void {
    pendingOther.push(['clearSampleFile', opIndex]);
    scheduleFlush();
  },

  /** LFO Function editor point data ("all LFOs are functions") isn't a
   *  bounded host float, so it travels over its own message instead of
   *  `setParam` — same precedent as `pickSampleFile`'s file path.
   *  `lfoIndex` is 1..3; `shapeJson` is a JSON-stringified `FunctionShape`. */
  setFunctionShape(lfoIndex: number, shapeJson: string): void {
    pendingOther.push(['setFunctionShape', lfoIndex, shapeJson]);
    scheduleFlush();
  },

  /** The parametric EQ's band list (todo.md) — an arbitrary-count array of
   *  {id,freq,gain,q,type}, same "not a bounded host float" precedent as
   *  `setFunctionShape` above. `bandsJson` is a JSON-stringified `EqBand[]`. */
  setEqBands(bandsJson: string): void {
    pendingOther.push(['setEqBands', bandsJson]);
    scheduleFlush();
  },

  /** Resample the plugin's own output into operator `opIndex`'s sampler
   *  (todo.md §167 S1). `on=false` stops and loads the take. */
  /** source: 0 = the synth's own output (resample), 1 = the audio input. */
  resampleRec(opIndex: number, on: boolean, source = 0): void {
    pendingOther.push(['resampleRec', opIndex, on ? 1 : 0, source]);
    scheduleFlush();
  },

  /** A multi-point envelope's shape — JSON of `{mode, durationSec, points, bipolar}`.
   *  Point data is not a bounded host float, so it travels here rather than as a
   *  parameter, exactly like `setFunctionShape` does for LFOs. `envId` is the
   *  source id ('env1'...'env11'). */
  setEnvShape(envId: string, json: string): void {
    pendingOther.push(['setEnvShape', envId, json]);
    scheduleFlush();
  },

  /** Native (audio-thread) arpeggiator/sequencer settings — JSON of ArpSettings. */
  setArpConfig(json: string): void {
    pendingOther.push(['setArpConfig', json]);
    scheduleFlush();
  },

  /** Open the wavetable folder in the OS file browser. */
  openWavetableFolder(): void {
    pendingOther.push(['openWavetableFolder']);
    scheduleFlush();
  },
  /** Pick a custom wavetable library folder (native async folder chooser). */
  setWavetableLibrary(): void {
    pendingOther.push(['setWavetableLibrary']);
    scheduleFlush();
  },
  /** Re-scan the wavetable folder (names come back via window.__userWavetables__). */
  rescanWavetables(): void {
    pendingOther.push(['rescanWavetables']);
    scheduleFlush();
  },
  /** Standalone window chrome (no-ops inside a plugin host). Sent immediately,
   *  not coalesced: a drag needs every move. */
  winDrag(phase: 'start' | 'move'): void { rawPost(['winDrag', phase]); },
  winCtl(what: 'min' | 'close' | 'options'): void { rawPost(['winCtl', what]); },
  /** True once native reports it is the Standalone app (not a plugin host). */
  isStandalone(): boolean { return standalone; },
  onStandalone(cb: () => void): () => void { standaloneListeners.add(cb); return () => standaloneListeners.delete(cb); },

  /** Tell native whether the EQ editor is on screen (gates the two EQ scopes). */
  setEqScopes(on: boolean): void {
    pendingOther.push(['eqScopes', on ? 1 : 0]);
    scheduleFlush();
  },

  /** Register for native state pushes. Returns an unsubscribe fn. */
  onState(cb: (flat: Record<string, number>) => void): () => void {
    const w = window as unknown as {
      __receiveStateChange__?: (json: string) => void;
      __receiveError__?: (e: { name: string; message: string }) => void;
    };
    w.__receiveStateChange__ = (json: string) => {
      let parsed: Record<string, number>;
      try {
        parsed = JSON.parse(json);
      } catch (e) {
        console.error('[bridge] bad state payload', e);
        return;
      }
      if (!standalone && (parsed as Record<string, number>).standalone === 1) {
        standalone = true;
        standaloneListeners.forEach((f) => f());
      }
      // Defer the React work out of the native callback too.
      setTimeout(() => cb(parsed), 0);
    };
    w.__receiveError__ = (e) => console.error(`[dsp ${e?.name}] ${e?.message}`);
    return () => {
      w.__receiveStateChange__ = undefined;
      w.__receiveError__ = undefined;
    };
  },
};
