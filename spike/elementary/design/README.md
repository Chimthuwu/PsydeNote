# FX UI design prototypes — "Sonic Material"

Standalone browser prototypes of the [visual-physics FX UI direction](../../../todo.md)
(todo.md §80 / §84). Open either `.html` directly in a browser — no build step,
no deps. They use Web Audio for the DSP; the real plugin will drive the same
canvas off the native Elementary graph (see §84).

- **`reverb-sonic-material.html`** — the reverb as an expanding reflection
  field: a central source, a chamber ellipse whose radius = Size, decay rings
  that expand and dissipate at the wall, a dot field whose density = Diffusion
  and persistence = Decay, mod-flow rings whose wobble = Mod at Rate speed,
  L/R split at Width, and a `damp → hue/brightness` palette (bright teal →
  dark violet as HiCut closes).
- **`delay-sonic-material.html`** — the delay as discrete echo pulses: each
  `pluck` fires N expanding rings spaced by Time, dimming by Feedback each
  generation, wobbling by Mod, spread L/R by Width, diffused (trail length +
  ring softness) by Diffusion, same `damp → palette`.

Shared conventions both prototypes establish:

- **Layout** — header status pill · big central generative canvas (`stage`)
  · controls row = 6 main knobs (grid) on the left + a `mix-big` knob and a
  LoCut/HiCut `filter-small` pair on the right · footer = preset chips + a
  hidden "TYPE" label that triggers a test `pluck()`.
- **Knob** — recessed SVG body, 270° value arc + glow in the param's fixed
  identity colour (`--kc`), tick ring, pointer line. Vertical drag, wheel,
  active-state label recolour. `--tint` follows the last-touched param's
  colour for ~1.2 s (the whole panel breathes that hue).
- **Interaction on the canvas itself** — drag near the chamber wall = Size,
  drag elsewhere = Decay (reverb); drag ↕ = Time (delay). Space / clicking
  "TYPE" = test pluck. Drop an audio file = IR (reverb) / loop source (delay).
- **Spring-smoothed params** (`P` follows `T` via a spring) so every visual
  move eases.
- **`paletteFromDamp()`** — the damping → colour ramp, shared verbatim.
- **Presets** — 7 per effect, each a full param snapshot.
