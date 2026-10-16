// ---------------------------------------------------------------------------
// On-screen + QWERTY keyboard for the browser preview. Emits plain
// noteOn(midi, vel) / noteOff(midi) — no audio knowledge.
// ---------------------------------------------------------------------------

// Single-row chromatic layout, Ableton-style. `a` is C of the base octave.
const KEY_ROW = {
  a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12,
};
const BLACK_IN_OCTAVE = new Set([1, 3, 6, 8, 10]);

export function installKeyboard(container, { onNoteOn, onNoteOff, getBaseMidi, shiftOctave }) {
  // --- on-screen keys: 2 octaves from the base -----------------------------
  const firstMidi = 60; // visual only; actual pitch uses getBaseMidi() at play time
  const whiteEls = [];
  const held = new Set();

  function build() {
    container.innerHTML = '';
    whiteEls.length = 0;
    const whiteCount = 15; // 2 octaves + 1
    let whiteIndex = 0;
    for (let s = 0; s < 25; s++) {
      const semitoneInOct = s % 12;
      const isBlack = BLACK_IN_OCTAVE.has(semitoneInOct);
      if (isBlack) {
        const b = document.createElement('div');
        b.className = 'bkey';
        b.style.left = `${(whiteIndex / whiteCount) * 100}%`;
        b.dataset.offset = String(s);
        container.appendChild(b);
      } else {
        const w = document.createElement('div');
        w.className = 'wkey';
        w.dataset.offset = String(s);
        container.appendChild(w);
        whiteEls.push(w);
        whiteIndex++;
      }
    }
  }
  build();

  function elForNote(midi) {
    const off = midi - firstMidi;
    return container.querySelector(`[data-offset="${off}"]`);
  }
  function noteOn(midi, vel = 0.8) {
    if (held.has(midi)) return;
    held.add(midi);
    const el = elForNote(midi);
    if (el) el.classList.add('down');
    onNoteOn(midi, vel);
  }
  function noteOff(midi) {
    if (!held.has(midi)) return;
    held.delete(midi);
    const el = elForNote(midi);
    if (el) el.classList.remove('down');
    onNoteOff(midi);
  }

  // --- pointer ------------------------------------------------------------
  let pointerDown = false;
  function noteFromEvent(e) {
    const el = e.target.closest('[data-offset]');
    if (!el) return null;
    return firstMidi + Number(el.dataset.offset);
  }
  container.addEventListener('pointerdown', (e) => {
    pointerDown = true;
    container.setPointerCapture(e.pointerId);
    const n = noteFromEvent(e);
    if (n != null) noteOn(n);
  });
  container.addEventListener('pointermove', (e) => {
    if (!pointerDown) return;
    const n = noteFromEvent(e);
    for (const m of [...held]) if (m !== n) noteOff(m);
    if (n != null) noteOn(n);
  });
  const endPointer = () => {
    pointerDown = false;
    for (const m of [...held]) noteOff(m);
  };
  container.addEventListener('pointerup', endPointer);
  container.addEventListener('pointercancel', endPointer);
  container.addEventListener('pointerleave', () => { if (pointerDown) endPointer(); });

  // --- QWERTY -----------------------------------------------------------
  const downKeys = new Set();
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { shiftOctave(-1); return; }
    if (k === 'x') { shiftOctave(1); return; }
    if (!(k in KEY_ROW) || downKeys.has(k)) return;
    downKeys.add(k);
    noteOn(getBaseMidi() + KEY_ROW[k], 0.8);
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    if (!(k in KEY_ROW)) return;
    downKeys.delete(k);
    noteOff(getBaseMidi() + KEY_ROW[k]);
  });
  window.addEventListener('blur', () => {
    downKeys.clear();
    for (const m of [...held]) noteOff(m);
  });
}
