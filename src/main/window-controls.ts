import { BrowserWindow, screen } from 'electron';
import {
  LAYOUT_MIN_SIZE,
  SnapTarget,
  WindowAction,
} from '../shared/types';
import { appBarOwner, registerAppBar, removeAppBar } from './appbar';
import { readSettings } from './settings';

/**
 * Window geometry helpers: screen-edge snapping, per-layout minimum sizes and
 * the verbs behind the custom title bar's buttons.
 *
 * Everything here works off the *work area* of whichever display the window
 * currently sits on, so docking to the top edge lands under nothing and leaves
 * the taskbar alone.
 */

/** How close (px) a dragged edge has to get before it snaps. */
const MAGNET_PX = 14;

/** Remembered height so leaving `bar` layout restores the previous size. */
let restoreHeight: number | null = null;
/** Height before a temporary expansion (see `tempExpand`). */
let preExpandHeight: number | null = null;

function workAreaFor(win: BrowserWindow) {
  const b = win.getBounds();
  const center = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  return screen.getDisplayNearestPoint(center).workArea;
}

export function performWindowAction(win: BrowserWindow | null, action: WindowAction) {
  if (!win || win.isDestroyed()) return;
  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'maximize':
      win.maximize();
      break;
    case 'restore-or-max':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'hide':
      win.hide();
      break;
    case 'close':
      // Same semantics as the OS close button: the tray keeps the app alive.
      win.close();
      break;
  }
}

/**
 * Park the window against an edge of its current display.
 *
 * `top` is the interesting one: it spans the full work-area width and keeps
 * the window's current height, which is what turns `bar` layout into a strip
 * across the top of the monitor.
 */
export function snapWindow(win: BrowserWindow | null, target: SnapTarget) {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();

  // Docking to the top can reserve desktop space so other applications lay out
  // below the strip rather than behind it. registerAppBar() positions the
  // window itself (the shell decides the exact rect), so there's nothing more
  // to do on this path.
  if (target === 'top' && readSettings().dockReservesSpace) {
    win.setMinimumSize(LAYOUT_MIN_SIZE.compact.width, 100);
    if (registerAppBar(win, 100)) return;
    // Fell through: not Windows, or the shell refused. Plain snap below.
  } else if (appBarOwner() === win) {
    // Moving somewhere else means we're no longer a top strip — give the
    // desktop space back before repositioning.
    removeAppBar();
  }

  const wa = workAreaFor(win);
  const b = win.getBounds();
  const halfW = Math.floor(wa.width / 2);
  const halfH = Math.floor(wa.height / 2);

  switch (target) {
    case 'top':
      // The user wants a thin strip when docked to the top, so we must drop
      // the layout's minHeight constraint first.
      win.setMinimumSize(LAYOUT_MIN_SIZE.compact.width, 100);
      win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: 100 });
      break;
    case 'bottom':
      win.setBounds({ x: wa.x, y: wa.y + wa.height - b.height, width: wa.width, height: b.height });
      break;
    case 'top-left':
      win.setBounds({ x: wa.x, y: wa.y, width: halfW, height: b.height });
      break;
    case 'top-right':
      win.setBounds({ x: wa.x + wa.width - halfW, y: wa.y, width: halfW, height: b.height });
      break;
    case 'left':
      win.setBounds({ x: wa.x, y: wa.y, width: Math.min(b.width, halfW), height: wa.height });
      break;
    case 'right':
      win.setBounds({
        x: wa.x + wa.width - Math.min(b.width, halfW),
        y: wa.y,
        width: Math.min(b.width, halfW),
        height: wa.height,
      });
      break;
    case 'center':
      win.setBounds({
        x: wa.x + Math.round((wa.width - b.width) / 2),
        y: wa.y + Math.round((wa.height - Math.min(b.height, halfH * 2)) / 2),
        width: b.width,
        height: b.height,
      });
      break;
  }
}

/**
 * Magnetic edge snap, wired to the window's `moved` event.
 *
 * Windows fires `moved` once the drag finishes, so this reads as "let go near
 * the top of the screen and the window clicks into place" rather than fighting
 * the cursor mid-drag.
 */
/**
 * Everything that should happen when a window finishes being dragged.
 *
 * Both windows wire this to `moved`. It exists so that releasing an appbar
 * reservation isn't conditional on `magneticSnap` being switched on — dragging
 * a docked strip away from the edge has to give the desktop space back either
 * way, or the user is left with a reserved gap and no window in it.
 */
export function handleWindowMoved(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  if (appBarOwner() === win) {
    const wa = workAreaFor(win);
    const b = win.getBounds();
    // The reservation *is* the strip's position, so the shell keeps us flush
    // with the top of the work area. Any real vertical displacement means the
    // user has pulled us out of the dock.
    if (Math.abs(b.y - wa.y) > MAGNET_PX) {
      removeAppBar();
    }
  }
  if (readSettings().magneticSnap) applyMagneticSnap(win);
}

/**
 * Resizing a docked strip has to resize the reservation with it, or the gap
 * the shell is holding stops matching the window sitting in it.
 */
export function reapplyOnResize(win: BrowserWindow | null) {
  if (!win || win.isDestroyed()) return;
  if (appBarOwner() !== win) return;
  registerAppBar(win, win.getBounds().height);
}

export function applyMagneticSnap(win: BrowserWindow | null) {
  if (!win || win.isDestroyed() || win.isMaximized()) return;
  const wa = workAreaFor(win);
  const b = win.getBounds();
  let { x, y } = b;

  if (Math.abs(b.y - wa.y) <= MAGNET_PX) y = wa.y;
  else if (Math.abs(b.y + b.height - (wa.y + wa.height)) <= MAGNET_PX) y = wa.y + wa.height - b.height;

  if (Math.abs(b.x - wa.x) <= MAGNET_PX) x = wa.x;
  else if (Math.abs(b.x + b.width - (wa.x + wa.width)) <= MAGNET_PX) x = wa.x + wa.width - b.width;

  if (x !== b.x || y !== b.y) win.setBounds({ ...b, x, y });
}

/**
 * Grow the window just long enough to show a popover that can't fit inside it.
 *
 * `bar` layout is a 38px strip — the source dropdown has nowhere to render, no
 * matter what CSS says, because the OS clips at the window edge. So the strip
 * grows while the list is open and snaps back when it closes. Pass `null` to
 * restore.
 */
export function tempExpand(win: BrowserWindow | null, height: number | null) {
  if (!win || win.isDestroyed() || win.isMaximized()) return;
  const b = win.getBounds();
  if (height != null) {
    if (preExpandHeight == null) preExpandHeight = b.height;
    if (height > b.height) win.setBounds({ ...b, height });
  } else if (preExpandHeight != null) {
    win.setBounds({ ...b, height: preExpandHeight });
    preExpandHeight = null;
  }
}

