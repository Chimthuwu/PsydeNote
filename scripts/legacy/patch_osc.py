import re

with open("src/renderer/components/OscillatorPanel.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Remove op-wave-knob-cell if it wasn't removed (my previous regex might have failed).
pattern_wave_cell_explicit = re.compile(
    r'<div className="op-wave-knob-cell">.*?onModContext=\{bindMod\(`\$\{id\}Wave`\)\.onModContext\}\s*title="Wave Morph Position"\s*/>\s*\)\}\s*</div>',
    re.DOTALL
)
content = pattern_wave_cell_explicit.sub("", content)


new_wavetable_container = """
            <div className="op-wavetable-row">
              <select
                className="op-warp-select"
                value={slot.wtId ?? 0}
                onChange={(e) => onChange({ wtId: parseInt(e.target.value, 10) })}
                title="Select Wavetable"
              >
                {WAVETABLES.map((wt) => (
                  <option key={wt.id} value={wt.id}>
                    {wt.name}
                  </option>
                ))}
              </select>
              <Knob
                label="WT Pos"
                value={slot.wtPos ?? 0}
                min={0}
                max={1}
                onChange={(v) => onChange({ wtPos: v })}
                format={(v) => v.toFixed(2)}
                color="var(--op-color)"
                size="md"
                modTarget={`${id}WtPos`}
                modGlow={modGlowFor(`${id}WtPos`, settings.mod?.[`${id}WtPos`] ?? [])}
                onModContext={bindMod(`${id}WtPos`).onModContext}
                title="Wavetable Scan Position"
              />
            </div>
"""

# Now replace before <ModCluster id={id} kind="pm"
if 'className="op-wavetable-row"' not in content:
    content = content.replace(
        '<ModCluster id={id} kind="pm"',
        new_wavetable_container + '            <ModCluster id={id} kind="pm"'
    )

with open("src/renderer/components/OscillatorPanel.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
