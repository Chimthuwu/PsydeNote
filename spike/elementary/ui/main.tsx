import './shims'; // must run before any src/renderer component imports
import { createRoot } from 'react-dom/client';
import '../../../src/renderer/styles.css';
import './plugin-ui.css';
import './topbar.css';
import './arp-ui.css';
import './seq-ui.css';
import './modstrip.css';
import { PluginApp } from './PluginApp';

// Neutralize an anomalous STARTING `devicePixelRatio` before first paint
// (todo.md §100/§101 — user: "app opens too zoomed in", confirmed via the
// new zoom readout showing 114% on a fresh launch with no persisted state,
// on a machine independently confirmed at 100% OS/monitor DPI scaling by
// three separate checks — registry LogPixels, registry AppliedDPI, and a
// live per-monitor-DPI-aware GetDpiForMonitor call. Whatever produces the
// 114% is happening inside WebView2/Chromium's own DPI detection for this
// embedded-in-JUCE hosting scenario, not the OS — not root-caused this
// session (ruled out OS scaling, persisted profile state, and JUCE's own
// `JUCE_WIN_PER_MONITOR_DPI_AWARE`, which is already on by default), so
// this compensates for its LAYOUT effect directly instead of chasing the
// exact mechanism further. `--ui-scale`'s CSS default (1.2) assumes
// devicePixelRatio 1 at startup; divide it by whatever devicePixelRatio
// ACTUALLY reads at mount so the effective rendered size holds regardless
// of the anomaly. Captured ONCE here, before React mounts (not re-applied
// on later devicePixelRatio changes) — a user's own subsequent Ctrl+scroll
// zoom should still work normally on top of this corrected baseline, not
// be fought by it. No-ops (sets 1.2 unchanged) on a machine that doesn't
// have the anomaly.
// Fit-to-window: the layout is designed for ~1274x924 layout px. Instead of a
// fixed scale (which clipped when zoomed in and left empty side gutters when
// zoomed out), recompute `--ui-scale` on every resize so the whole UI always
// fits the window. This also absorbs the 114% starting-DPR anomaly and any
// Ctrl+scroll zoom (todo.md §100/§101), so the old one-shot DPR compensation
// is gone.
{
  const DESIGN_W = 1274;
  const DESIGN_H = 992;
  const fit = () => {
    const s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
    if (s > 0.2 && isFinite(s)) {
      document.documentElement.style.setProperty('--ui-scale', s.toFixed(4));
    }
  };
  fit();
  window.addEventListener('resize', fit);
}

// No StrictMode: its double-render/double-mount is pure waste in the plugin
// webview (and double-mounts every canvas effect + ResizeObserver).
const el = document.getElementById('root');
if (el) {
  createRoot(el).render(<PluginApp />);
}
