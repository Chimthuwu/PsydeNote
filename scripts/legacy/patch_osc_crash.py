import re

with open("src/renderer/components/OscillatorPanel.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# Replace WARP_MODES[slot.warpMode ?? 0]?.param2Name with WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name
content = content.replace(
    "WARP_MODES[slot.warpMode ?? 0]?.param2Name",
    "WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name"
)

content = content.replace(
    "WARP_MODES[slot.warpMode ?? 0].param2Name",
    "WARP_MODES.find(m => m.id === (slot.warpMode ?? 0))?.param2Name"
)

content = content.replace(
    "WARP_MODES[slot.warpMode2 ?? 0]?.param2Name",
    "WARP_MODES.find(m => m.id === (slot.warpMode2 ?? 0))?.param2Name"
)

content = content.replace(
    "WARP_MODES[slot.warpMode2 ?? 0].param2Name",
    "WARP_MODES.find(m => m.id === (slot.warpMode2 ?? 0))?.param2Name"
)

# And fix wavetable selection to force wave: 'wavetable'
content = content.replace(
    "onChange={(e) => onChange({ wtId: parseInt(e.target.value, 10) })}",
    "onChange={(e) => onChange({ wave: 'wavetable', wtId: parseInt(e.target.value, 10) })}"
)
content = content.replace(
    "onChange={(v) => onChange({ wtPos: v })}",
    "onChange={(v) => onChange({ wave: 'wavetable', wtPos: v })}"
)

with open("src/renderer/components/OscillatorPanel.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
