// Differential harness — native (WtSpectralWarp.h via diff-main.cpp, cl.exe)
// vs JS reference (dsp/wavetables.js applySpectralWarp, Node). Byte-exact bar
// over the full mode x param matrix. Run: `node run-diff.mjs` (from this dir).
//
// The 15 spectral modes are 13 and 16..29. Sweep amount x param2 across the
// ranges the UI knobs actually produce (the resource key quantizes both to
// whole percent, so 0.01 steps are the finest the plugin can request), plus
// the allFrames-dependent modes (21, 29) against a real 8-frame base set.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = join(HERE, '..', '..', 'plugin');
const MSVC_SETUP = 'Z:\\msvc\\msvc\\setup_x64.bat';
const TMP = join(HERE, 'tmp');
const MODES = [13, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29];

function findCl() {
  // Locate cl.exe the same way the plugin build does (portable MSVC).
  mkdirSync(TMP, { recursive: true });
  const probe = `@echo off\r\ncall "${MSVC_SETUP}"\r\nwhere cl.exe\r\n`;
  const bat = join(TMP, 'where-cl.bat');
  writeFileSync(bat, probe);
  const out = execFileSync('cmd.exe', ['/c', bat], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, encoding: 'utf8' });
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.toLowerCase().endsWith('cl.exe'));
  if (!line) throw new Error('cl.exe not found via ' + MSVC_SETUP);
  return line;
}

function runCl(batBody) {
  const bat = join(TMP, 'cl-step.bat');
  writeFileSync(bat, `@echo off\r\ncall "${MSVC_SETUP}"\r\n${batBody}\r\nif errorlevel 1 exit /b 1\r\n`);
  execFileSync('cmd.exe', ['/c', bat], { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, stdio: 'inherit' });
}

// Base-frame set: a spread of the real built-ins, so modes 21/29 exercise
// actual table data rather than a toy set. Written once as 8 x 2048 f32.
function writeBaseFrames() {
  const p = join(TMP, 'base-frames.bin');
  if (existsSync(p)) return p;
  const script = `
    import { writeFileSync } from 'node:fs';
    import { getBaseWavetableFrames } from '${'../../dsp/wavetables.js'}';
    const ids = [0, 1, 0, 1, 0, 1, 0, 1];
    const bufs = ids.map((id, i) => getBaseWavetableFrames(id)[i % 8]);
    writeFileSync(process.argv[2], Buffer.concat(bufs.map((f) => Buffer.from(f.buffer, f.byteOffset, f.byteLength))));
  `;
  writeFileSync(join(HERE, 'write-base.mjs'), script);
  execFileSync(process.execPath, [join(HERE, 'write-base.mjs'), p], { cwd: HERE });
  return p;
}

const clPath = findCl();
mkdirSync(TMP, { recursive: true });
console.log('cl.exe:', clPath);

runCl(`cl /nologo /O2 /EHsc /W3 /I "${PLUGIN_DIR}" "${join(HERE, 'diff-main.cpp')}" /Fe:"${join(TMP, 'diff-native.exe')}" /Fo:"${join(TMP, 'diff-main.obj')}"`);
console.log('native driver compiled.');

const baseFrames = writeBaseFrames();
const exe = join(TMP, 'diff-native.exe');

let cases = 0;
let mismatches = [];
const AMOUNTS = [0.01, 0.25, 0.5, 0.75, 1.0];
const PARAM2S = [0.01, 0.25, 0.5, 0.75, 1.0];

for (const mode of MODES) {
  const needsFrames = mode === 21 || mode === 29;
  for (const amount of AMOUNTS) {
    for (const param2 of PARAM2S) {
      const args = [String(mode), String(amount), String(param2), needsFrames ? baseFrames : 'null', '3'];
      const cppOut = join(TMP, 'cpp.bin');
      const jsOut = join(TMP, 'js.bin');
      execFileSync(exe, [cppOut, ...args]);
      execFileSync(process.execPath, [join(HERE, 'js-side.mjs'), jsOut, ...args]);
      cases++;
      const a = readFileSync(cppOut);
      const b = readFileSync(jsOut);
      if (!a.equals(b)) {
        // Locate the first differing sample for the report.
        let first = -1;
        for (let i = 0; i < Math.min(a.length, b.length) / 4; i++) {
          if (a.readFloatLE(i * 4) !== b.readFloatLE(i * 4)) { first = i; break; }
        }
        mismatches.push({ mode, amount, param2, firstDiffSample: first });
      }
    }
  }
}

if (mismatches.length > 0) {
  console.error(`FAIL: ${mismatches.length}/${cases} cases differ byte-wise. First few:`);
  for (const m of mismatches.slice(0, 10)) console.error(' ', JSON.stringify(m));
  process.exit(1);
}
console.log(`PASS: ${cases}/${cases} cases bit-identical across modes ${MODES.join(',')} (amount x param2 = ${AMOUNTS.length}x${PARAM2S.length} each${' '}
${MODES.includes(21) ? ', incl. allFrames-dependent 21/29' : ''}).`);
