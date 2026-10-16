/**
 * Theme token propagation probe (todo.md 2026-10-10 — "weird white/grey haze
 * over the UI ... seems to have changed all themes").
 *
 * The bug: the theme class was applied to `<body>` and the inner `.app` div,
 * but NOT to `<html>`. `styles.css` paints `html, body, #root` with
 * `background: var(--bg)`, and `--bg` is an alias for `--bg-app` that resolves
 * against whichever element READS it. `<html>` never had the class, so it read
 * `:root`'s bare Aurora-ice `#070a1c` — a blue-grey LIGHTER than all three real
 * themes — and showed as a haze wherever `<body>` did not cover the viewport
 * (scrollbar gutters, overscroll, the popout).
 *
 * Why a source-grep probe and not a browser test: the fix is "the theme class
 * must be set on documentElement", which is one line of code in two files. The
 * value here is that the assertion is written against the RULE (every theme-
 * applying site must also set documentElement) so a NEW theme entry point added
 * later fails the probe instead of silently reintroducing the haze.
 *
 *   node spike/elementary/test/.theme-token-probe.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const read = (p) => readFileSync(resolve(root, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass += 1; console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { fail += 1; console.log(`FAIL  ${name}${detail ? `  (${detail})` : ''}`); }
}

// --- 1. Every theme-applying site must also reach <html> ---------------------
const pluginApp = read('spike/elementary/ui/PluginApp.tsx');
check('plugin sets the theme class on documentElement',
  /document\.documentElement\.className\s*=\s*`theme-\$\{theme\}`/.test(pluginApp));
check('plugin still sets it on body (portals depend on it)',
  /document\.body\.className\s*=\s*`theme-\$\{theme\}`/.test(pluginApp));
check('both are cleared on unmount (no stale theme after teardown)',
  (pluginApp.match(/document\.(body|documentElement)\.className\s*=\s*''/g) || []).length === 2);

const electronApp = read('src/renderer/App.tsx');
check('Electron sets the theme class on documentElement',
  /document\.documentElement\.className\s*=\s*themeClass/.test(electronApp));
check('Electron still sets it on .app (existing cascade)',
  /className=\{`app \$\{themeClass\}/.test(electronApp));

// --- 2. html must paint the THEME background, not a hard-coded one -----------
const css = read('src/renderer/styles.css');
const htmlRule = css.match(/^html\s*\{[^}]*\}/m);
check('an explicit `html { background }` rule exists', !!htmlRule, htmlRule ? htmlRule[0].slice(0, 60) : 'not found');
check('that rule reads a theme token, not a literal colour',
  !!htmlRule && /var\(--bg-app/.test(htmlRule[0]));
check('it is NOT background: inherit (html has no parent to inherit from)',
  !htmlRule || !/inherit/.test(htmlRule[0]));

// --- 3. No theme may be lighter than the darkest page ----------------------
// The concrete failure was `:root`'s bare --bg-app being lighter than every
// real theme. Catch a NEW :root background sneaking back in.
const rootBg = css.match(/:root\s*\{[^}]*--bg-app:\s*(#[0-9a-fA-F]{3,8})/);
check('a :root --bg-app exists to compare against', !!rootBg, rootBg ? rootBg[1] : 'none');

function hexToRgb(h) {
  const s = h.length <= 4 ? h.slice(1).split('').map((c) => c + c).join('') : h.slice(1, 7);
  return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
}
const lum = (h) => { const [r, g, b] = hexToRgb(h); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

if (rootBg) {
  const rootLum = lum(rootBg[1]);
  const themes = [...css.matchAll(/\.theme-([a-z-]+)\s*\{\s*--bg-app:\s*(#[0-9a-fA-F]{3,8})/g)];
  check('all three themes declare --bg-app', themes.length === 3, themes.map((t) => t[1]).join(','));
  // The haze case: :root lighter than a theme. Aurora ice (#02030a) and
  // graphite (#0b0c0e) are both DARKER than :root's #070a1c.
  const offenders = themes.filter((t) => lum(t[2]) < rootLum).map((t) => t[1]);
  check('no theme is darker than the :root default it falls back to',
    offenders.length === 0,
    offenders.length ? `${offenders.join(',')} would haze (root ${rootBg[1]} lum ${rootLum.toFixed(1)})` : '');
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);