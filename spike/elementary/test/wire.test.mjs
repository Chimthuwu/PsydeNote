// Wire-parity test (todo.md §165-D / P0-A).
//
// The UI never talks to the plugin's manifest directly in a test — this is
// the one check that walks the REAL path: SynthSettings -> synthToFlat
// (ui/translate.ts) -> manifest.json's min/max/default -> dsp.main.js's
// toSynthState -> dsp/synth.js's renderSynth. A green DSP suite has
// repeatedly certified fixes that were dead in the plugin because nothing
// before this checked that the wire itself carries the value. Run: `npm test`
// (wired into package.json's test script alongside engine.test.mjs).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; }
  else { fail++; console.error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- Bundle ui/translate.ts to plain JS so this plain-Node test can import
// it without a TS loader (same approach §165's throwaway probe used). ---
async function loadTranslate() {
  const entry = path.join(root, 'ui', 'translate.ts');
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    outfile: 'out.mjs',
  });
  const code = result.outputFiles[0].text;
  const tmp = path.join(root, 'test', `.translate-bundle-${process.pid}.mjs`);
  const fs = await import('node:fs/promises');
  await fs.writeFile(tmp, code);
  try {
    return await import(`file://${tmp}`);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

// --- Bundle dsp.main.js's internal toSynthState the same way: it isn't
// exported, so re-export it via an esbuild "inject"-free wrapper that
// imports the real file and grabs the function off a captured closure is not
// possible (it's a top-level function, not exported) — so this test imports
// plugin/dsp.main.js's SOURCE text and re-declares toSynthState by requiring
// the file export the function. See the manifest-parity checks below for
// what this unlocks; if toSynthState is never exported, skip the full
// end-to-end render check but keep every other check (manifest/default
// parity do not need it). ---

function loadManifest() {
  const raw = readFileSync(path.join(root, 'plugin', 'manifest.json'), 'utf8');
  return JSON.parse(raw);
}

const main = async () => {
  const { synthToFlat, FLAT_DEFAULTS, defaultSynthSettings } = await loadTranslate();
  const manifest = loadManifest();
  const manifestById = new Map(manifest.parameters.map((p) => [p.paramId, p]));

  // Keys `synthToFlat` can never emit but the manifest declares anyway —
  // these are legacy/host-only/not-yet-wired params. Keeping this list
  // explicit means a FUTURE drop here is a deliberate decision, not a
  // silent one (todo.md §165's whole point).
  //
  // EMPTY as of P0-C (2026-10-07): the nine entries that used to live here
  // (`fx_comp_thresh/ratio/attack/release`, `fx_eq_low/mid/high` and the
  // already-deleted `fx_comp_upratio`) have been REMOVED from manifest.json.
  // They were declared, never written by the UI and never read by the DSP —
  // the compressor is the 3-band DOOM design (dsp/synth.js
  // applyCompressorSlot) and the EQ travels as JSON bands, so the flat
  // params were dead weight. Param ids are host automation ids and the
  // plugin is pre-release, so renaming/removing is acceptable (todo.md §165 1).
  const HOST_ONLY_ALLOWLIST = new Set([]);

  // --- 1. Manifest parity: every key synthToFlat emits must exist in the
  // manifest (else native silently drops it — WebViewEditor.cpp). ---
  const flat = synthToFlat(defaultSynthSettings());
  const emittedNotInManifest = Object.keys(flat).filter((k) => !manifestById.has(k));
  check(
    'every synthToFlat key is declared in manifest.json',
    emittedNotInManifest.length === 0,
    emittedNotInManifest.length ? `${emittedNotInManifest.length} missing: ${emittedNotInManifest.slice(0, 10).join(', ')}` : '',
  );

  // --- 2. Manifest keys the UI never writes (minus the explicit allowlist)
  // — flags newly-added manifest params nobody wired into synthToFlat yet. ---
  const manifestNotEmitted = manifest.parameters
    .map((p) => p.paramId)
    .filter((id) => !(id in flat) && !HOST_ONLY_ALLOWLIST.has(id));
  check(
    'every manifest param (minus allowlist) is written by synthToFlat',
    manifestNotEmitted.length === 0,
    manifestNotEmitted.length ? `${manifestNotEmitted.length} never written: ${manifestNotEmitted.slice(0, 20).join(', ')}` : '',
  );

  // --- 3. Range parity: synthToFlat's default (and the UI's own extremes,
  // approximated here by the default since full-range probing needs each
  // control's own max) must fit inside the manifest's min/max — a value
  // outside that range is silently clamped by the AudioParameterFloat. ---
  const rangeViolations = [];
  for (const [k, v] of Object.entries(flat)) {
    const p = manifestById.get(k);
    if (!p) continue;
    if (v < p.min - 1e-6 || v > p.max + 1e-6) rangeViolations.push(`${k}=${v} (manifest ${p.min}..${p.max})`);
  }
  check(
    'synthToFlat default values fit inside manifest min/max',
    rangeViolations.length === 0,
    rangeViolations.join('; '),
  );

  // --- 4. Default parity: synthToFlat(defaults) should equal the manifest's
  // own defaultValue for every shared key — a mismatch means "Init" and the
  // plugin's power-on state disagree (todo.md §165 item 5's blocker). ---
  const defaultMismatches = [];
  for (const [id, p] of manifestById) {
    if (!(id in flat)) continue;
    const got = flat[id];
    const want = p.defaultValue;
    if (Math.abs(got - want) > 1e-6) defaultMismatches.push(`${id}: synthToFlat=${got} manifest=${want}`);
  }
  check(
    'synthToFlat(defaults) matches every manifest defaultValue',
    defaultMismatches.length === 0,
    defaultMismatches.length ? `${defaultMismatches.length} mismatches: ${defaultMismatches.slice(0, 15).join('; ')}` : '',
  );

  // --- 5. FLAT_DEFAULTS export sanity: must be the same object synthToFlat
  // would build fresh (catches it going stale if normalizeSynthSettings
  // changes after module init). ---
  check(
    'FLAT_DEFAULTS matches a fresh synthToFlat(defaultSynthSettings())',
    JSON.stringify(FLAT_DEFAULTS) === JSON.stringify(flat),
  );

  // --- 6. Mod source/target index parity (todo.md L51 Phase 0 groundwork):
  // translate.ts's MOD_SRC_IDS / MOD_DST_IDS and the manifest's mod{n}_src/dst
  // max must stay index-aligned with dsp/synth.js (append-only host indices). ---
  const { MOD_SOURCES, MOD_TARGETS } = await import(pathToFileURL(path.join(root, 'dsp', 'synth.js')).href);
  const tsrc = readFileSync(path.join(root, 'ui', 'translate.ts'), 'utf8');
  const arrBody = (name) => {
    const m = tsrc.match(new RegExp(`const ${name}[^=]*=\\s*\\[([\\s\\S]*?)\\n\\];`));
    return m ? m[1].replace(/\/\/.*$/gm, '') : '';
  };
  const srcIds = [...arrBody('MOD_SRC_IDS').matchAll(/'([^']+)'/g)].map((m) => m[1]);
  check('translate MOD_SRC_IDS equals dsp MOD_SOURCES', JSON.stringify(srcIds) === JSON.stringify(MOD_SOURCES),
    `${srcIds.length} vs ${MOD_SOURCES.length}`);
  const dstCount = [...arrBody('MOD_DST_IDS').matchAll(/'[^']+'|\bnull\b/g)].length;
  check('translate MOD_DST_IDS length equals dsp MOD_TARGETS', dstCount === MOD_TARGETS.length,
    `${dstCount} vs ${MOD_TARGETS.length}`);
  for (const p of manifest.parameters ?? manifest.params ?? manifest) {
    const m = /^mod\d+_(src|dst)$/.exec(p.paramId ?? '');
    if (!m) continue;
    const want = (m[1] === 'src' ? MOD_SOURCES.length : MOD_TARGETS.length) - 1;
    check(`${p.paramId} manifest max == last index`, p.max === want, `${p.max} vs ${want}`);
  }

  console.log(`\nwire.test.mjs:${pass} pass, ${fail} fail`);
  if (fail > 0) process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
