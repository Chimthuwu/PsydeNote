// Assembles spike/elementary/dist/ — the bundle the JUCE plugin loads.
//
// Three files:
//   dsp.main.js   — plugin/dsp.main.js bundled to a single IIFE (QuickJS has
//                   no module resolution). Imports ../dsp/synth.js verbatim.
//   manifest.json — parameter declarations, read by PluginProcessor
//   index.html    — the P7 React UI (todo.md §73), built by `vite build
//                   --config vite.config.ui.mjs` into a single self-contained
//                   file (JS + CSS inlined). Falls back to plugin/index.html
//                   (the old placeholder) if SKIP_UI=1 or the vite build fails.
import { build } from 'esbuild';
import { mkdir, copyFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

await mkdir(dist, { recursive: true });

await build({
  entryPoints: [resolve(root, 'plugin/dsp.main.js')],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  outfile: resolve(dist, 'dsp.main.js'),
  logLevel: 'info',
});

await copyFile(resolve(root, 'plugin/manifest.json'), resolve(dist, 'manifest.json'));

// ----- UI (index.html) -----------------------------------------------------
const uiBuilt = resolve(root, 'ui/dist/index.html');
let useReactUi = process.env.SKIP_UI !== '1';
if (useReactUi) {
  console.log('building React UI (vite.config.ui.mjs)…');
  const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
  const r = spawnSync(process.execPath, [viteBin, 'build', '--config', 'vite.config.ui.mjs'], {
    cwd: root,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.warn('UI build failed — falling back to the placeholder index.html');
    useReactUi = false;
  }
}
if (useReactUi) {
  await access(uiBuilt);
  await copyFile(uiBuilt, resolve(dist, 'index.html'));
  console.log('index.html <- ui/dist/index.html (React UI)');
} else {
  await copyFile(resolve(root, 'plugin/index.html'), resolve(dist, 'index.html'));
  console.log('index.html <- plugin/index.html (placeholder)');
}

console.log('dist/ assembled:', dist);
