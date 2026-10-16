import { app, BrowserWindow, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Windows *application desktop toolbar* ("appbar") registration.
 *
 * Docking a floating always-on-top window to the top of a screen still leaves
 * it covering whatever is behind it — a maximised browser keeps its tab strip
 * and address bar underneath, hidden. Registering as an appbar is what the
 * taskbar itself does: the shell shrinks the desktop work area, and every other
 * window lays itself out below us.
 *
 * There is no Electron API for this, so we call `shell32!SHAppBarMessage`
 * through koffi. koffi ships prebuilt N-API binaries, which matters because
 * this project has no node-gyp toolchain available (see the Phase 3 notes in
 * todo.md).
 *
 * ⚠️ The dangerous failure mode is a *stale registration*: reserved desktop
 * space with no window in it, which the user cannot reclaim without logging
 * out. Every exit path therefore has to reach `removeAppBar()` — see
 * `wireAppBarTeardown()`, which is wired from main's `init()`.
 */

const ABM_NEW = 0x00000000;
const ABM_REMOVE = 0x00000001;
const ABM_QUERYPOS = 0x00000002;
const ABM_SETPOS = 0x00000003;

/** ABE_* — we only ever dock to the top, but the API is edge-generic. */
const ABE_TOP = 1;

/**
 * Hard ceiling on how much of a display we will ever reserve.
 *
 * This exists because of a real incident: a *maximised* window was docked, and
 * because `unmaximize()` hadn't taken effect by the time we read `getBounds()`,
 * we asked the shell to reserve 1096px of a 1080px display. The result was a
 * desktop with a 172px usable strip — icons flung to the bottom, nothing able
 * to maximise. A strip is a strip; anything approaching a fifth of the screen
 * is a bug, not a user intention, and must be refused rather than honoured.
 */
const MAX_STRIP_FRACTION = 0.2;
const MAX_STRIP_PX = 300;
const MIN_STRIP_PX = 20;

/** Marker file: present between a successful register and a clean remove. */
function markerPath(): string {
  return path.join(app.getPath('userData'), 'appbar-active');
}

/**
 * Callback message the shell posts for ABN_* notifications. It must be
 * non-zero and in the WM_APP range. Electron's window proc doesn't dispatch it
 * — see the note on `reapply()` for how position changes are handled instead.
 */
const WM_FAZE_APPBAR = 0x8000 + 1; // WM_APP + 1

interface AppBarApi {
  SHAppBarMessage: (msg: number, data: AppBarData) => number | bigint;
  size: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface AppBarData {
  cbSize: number;
  hWnd: number | bigint;
  uCallbackMessage: number;
  uEdge: number;
  rc: Rect;
  lParam: number | bigint;
}

let api: AppBarApi | null = null;
let apiLoadFailed = false;

/**
 * Load koffi and bind SHAppBarMessage. Lazy and failure-tolerant: a missing or
 * broken native module must degrade to "docking just doesn't reserve space",
 * never to a crash on startup.
 */
function getApi(): AppBarApi | null {
  if (api) return api;
  if (apiLoadFailed || process.platform !== 'win32') return null;
  try {
    // Required lazily so non-Windows builds never touch the native module.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const RECT = koffi.struct('RECT', {
      left: 'long',
      top: 'long',
      right: 'long',
      bottom: 'long',
    });
    // Field order and padding must match the Win32 x64 ABI exactly; koffi
    // computes this and we assert the well-known 48-byte size below.
    const APPBARDATA = koffi.struct('APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'uintptr_t',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: RECT,
      lParam: 'int64',
    });
    const size = koffi.sizeof(APPBARDATA);
    if (size !== 48) {
      // Wrong layout means we'd hand the shell garbage. Refuse rather than
      // corrupt the desktop work area.
      console.warn(`[appbar] unexpected APPBARDATA size ${size}, disabling`);
      apiLoadFailed = true;
      return null;
    }
    const SHAppBarMessage = shell32.func(
      'uintptr_t __stdcall SHAppBarMessage(uint32 dwMessage, _Inout_ APPBARDATA *pData)',
    );
    api = { SHAppBarMessage, size };
    return api;
  } catch (err) {
    console.warn('[appbar] koffi unavailable, docking will not reserve space:', err);
    apiLoadFailed = true;
    return null;
  }
}

/** The window currently holding the reservation, if any. Only one at a time. */
let owner: BrowserWindow | null = null;
let ownerHwnd: bigint = BigInt(0);
/** Height in DIP the caller asked us to reserve, so `reapply()` can redo it. */
let reservedDip = 0;

function hwndOf(win: BrowserWindow): bigint {
  // getNativeWindowHandle() returns a Buffer *containing* the HWND, not the
  // handle itself.
  const buf = win.getNativeWindowHandle();
  return buf.length === 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
}

function blank(hWnd: bigint, size: number): AppBarData {
  return {
    cbSize: size,
    hWnd,
    uCallbackMessage: WM_FAZE_APPBAR,
    uEdge: ABE_TOP,
    rc: { left: 0, top: 0, right: 0, bottom: 0 },
    lParam: 0,
  };
}

export function isAppBarRegistered(): boolean {
  return owner !== null && !owner.isDestroyed();
}

export function appBarOwner(): BrowserWindow | null {
  return isAppBarRegistered() ? owner : null;
}

/**
 * Reserve a strip at the top of `win`'s current display and move `win` into it.
 *
 * Note what this deliberately does *not* use: `display.workArea`. Once we
 * register, the work area excludes our own strip, so deriving the strip from it
 * would walk the window a little further down the screen on every re-dock.
 * `display.bounds` is the stable input, and `ABM_QUERYPOS` is what accounts for
 * the taskbar and any other appbars — that's the shell's job, not ours.
 *
 * Returns false when unavailable (non-Windows, koffi missing, shell refused).
 */
export function registerAppBar(win: BrowserWindow | null, heightDip?: number): boolean {
  if (!win || win.isDestroyed()) return false;
  const a = getApi();
  if (!a) return false;

  // Only one reservation makes sense; if the other window held it, hand over.
  if (owner && !owner.isDestroyed() && owner !== win) removeAppBar();

  // A maximised window's bounds are the whole display, and `unmaximize()` does
  // not take effect synchronously on Windows — reading getBounds() straight
  // after it returns the *old* maximised size. Reserving that is how the
  // desktop gets eaten, so refuse outright and let the caller fall back to a
  // plain snap.
  if (win.isMaximized() || win.isFullScreen()) return false;

  const hWnd = hwndOf(win);
  const bounds = win.getBounds();
  const display = screen.getDisplayNearestPoint({
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  });

  const requested = Math.round(heightDip ?? bounds.height);
  const ceiling = Math.min(MAX_STRIP_PX, Math.floor(display.bounds.height * MAX_STRIP_FRACTION));
  if (!Number.isFinite(requested) || requested < MIN_STRIP_PX || requested > ceiling) {
    console.warn(
      `[appbar] refusing to reserve ${requested}px on a ${display.bounds.height}px display ` +
        `(allowed ${MIN_STRIP_PX}..${ceiling})`,
    );
    return false;
  }
  const dip = requested;

  try {
    if (!isAppBarRegistered() || ownerHwnd !== hWnd) {
      const reg = blank(hWnd, a.size);
      if (!Number(a.SHAppBarMessage(ABM_NEW, reg))) {
        // Already registered from a previous run that didn't clean up, or the
        // shell said no. Either way we must not proceed to SETPOS.
        return false;
      }
    }

    // Desired strip, in *physical* pixels — the shell knows nothing about DIP.
    const wantDip = {
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: dip,
    };
    const wantPx = screen.dipToScreenRect(win, wantDip);

    const data = blank(hWnd, a.size);
    data.rc = {
      left: wantPx.x,
      top: wantPx.y,
      right: wantPx.x + wantPx.width,
      bottom: wantPx.y + wantPx.height,
    };

    // QUERYPOS adjusts rc around the taskbar and any other appbars; SETPOS
    // commits it. Both mutate rc in place.
    a.SHAppBarMessage(ABM_QUERYPOS, data);
    // QUERYPOS can move the strip but keeps our requested thickness only if we
    // re-assert it — it is allowed to return a taller rect on some shells.
    data.rc.bottom = data.rc.top + wantPx.height;
    a.SHAppBarMessage(ABM_SETPOS, data);

    owner = win;
    ownerHwnd = hWnd;
    reservedDip = dip;
    // Written *after* the shell has accepted the reservation, so a marker on
    // disk always means "space is actually reserved right now".
    writeMarker();

    // Move into the space the shell granted — but take only the *vertical*
    // placement back from it. Round-tripping the full rect through
    // dipToScreenRect → screenToDipRect accumulates scale-factor rounding and
    // produced a window 3px wider than the monitor. x/width are already known
    // exactly in DIP, so they never make the trip.
    const grantedTop = screen.screenToDipRect(win, {
      x: data.rc.left,
      y: data.rc.top,
      width: 1,
      height: 1,
    }).y;
    win.setBounds({
      x: display.bounds.x,
      y: Math.round(grantedTop),
      width: display.bounds.width,
      height: dip,
    });
    return true;
  } catch (err) {
    console.warn('[appbar] register failed:', err);
    // Never leave a half-registered appbar behind.
    try { removeAppBar(); } catch { /* noop */ }
    return false;
  }
}

/** Give the desktop space back. Safe to call when nothing is registered. */
export function removeAppBar(): void {
  const a = getApi();
  if (!a || ownerHwnd === BigInt(0)) {
    owner = null;
    clearMarker();
    return;
  }
  try {
    a.SHAppBarMessage(ABM_REMOVE, blank(ownerHwnd, a.size));
  } catch (err) {
    console.warn('[appbar] remove failed:', err);
  } finally {
    owner = null;
    ownerHwnd = BigInt(0);
    reservedDip = 0;
    clearMarker();
  }
}

function writeMarker(): void {
  try { fs.writeFileSync(markerPath(), String(Date.now()), 'utf8'); } catch { /* noop */ }
}

function clearMarker(): void {
  try { fs.rmSync(markerPath(), { force: true }); } catch { /* noop */ }
}

/**
 * Force the primary display's work area back to the full screen.
 *
 * The shell re-reserves the taskbar's own strip immediately, so this restores
 * the correct work area rather than clobbering it. Used only by the stale
 * reclaim below — never on a healthy path, because it would also stomp any
 * legitimate third-party appbar (a dock, a second toolbar).
 */
function resetWorkArea(): boolean {
  if (process.platform !== 'win32') return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    const RECT = koffi.struct('RECT_WA', {
      left: 'long', top: 'long', right: 'long', bottom: 'long',
    });
    const SystemParametersInfoW = user32.func(
      'bool __stdcall SystemParametersInfoW(uint32 uiAction, uint32 uiParam, _Inout_ RECT_WA *pvParam, uint32 fWinIni)',
    );
    const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)');
    const full = {
      left: 0,
      top: 0,
      right: GetSystemMetrics(0), // SM_CXSCREEN
      bottom: GetSystemMetrics(1), // SM_CYSCREEN
    };
    // SPI_SETWORKAREA | SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
    return !!SystemParametersInfoW(0x002f, 0, full, 0x01 | 0x02);
  } catch (err) {
    console.warn('[appbar] work-area reset failed:', err);
    return false;
  }
}

/**
 * Recover from a reservation that outlived the process.
 *
 * Windows does *not* reliably reclaim appbar space when the owning process is
 * killed — verified the hard way, with a hard-killed build leaving the primary
 * display with a 172px usable strip. So: a marker file is written while a
 * reservation is live and deleted on a clean remove. Finding it at startup
 * means the last run died holding one, and the work area needs forcing back.
 *
 * Called from main's init, before any window can register a new one.
 */
export function reclaimStaleAppBar(): void {
  let stale = false;
  try { stale = fs.existsSync(markerPath()); } catch { /* noop */ }
  if (!stale) return;
  console.warn('[appbar] previous run exited holding a reservation; reclaiming desktop space');
  resetWorkArea();
  clearMarker();
}

/**
 * Re-assert the reservation.
 *
 * The shell notifies appbars of layout changes by posting ABN_POSCHANGED to the
 * `uCallbackMessage` we registered — but that lands in Electron's window proc,
 * which doesn't dispatch it, and there is no supported way to hook it without a
 * native window subclass. So instead main re-applies on the Electron-level
 * signals that stand in for it: display metrics changing, displays being added
 * or removed, and the docked window being resized.
 */
export function reapplyAppBar(): void {
  if (!isAppBarRegistered()) return;
  registerAppBar(owner, reservedDip);
}

/**
 * Wire the teardown paths. Call once from main's init.
 *
 * This is the important part of the whole module: a reservation that outlives
 * its window leaves the user with a dead strip of desktop they can't reclaim
 * without logging out.
 */
export function wireAppBarTeardown(app: Electron.App): void {
  const drop = () => removeAppBar();
  app.on('before-quit', drop);
  app.on('will-quit', drop);
  app.on('window-all-closed', drop);
  // Belt and braces: if the renderer process dies, the HWND goes with it.
  process.on('exit', drop);
}
