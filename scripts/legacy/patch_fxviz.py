import re

with open("spike/elementary/ui/FxViz.tsx", "r", encoding="utf-8") as f:
    content = f.read()

# 1. Remove ATK/REL knobs from drawing
content = re.sub(
    r"if \(\!isCompact && dialsW > 40\) \{.*?\drawNumberDial.*?drawNumberDial.*?\}",
    "",
    content,
    flags=re.DOTALL
)

# 2. Update hit testing in onDown for compressor
on_down_compressor_regex = r"(if \(kind === 'compressor'\) \{\s*const p = pRef\.current as CompressorFxSettings;\s*const cx = e\.clientX - rect\.left;\s*const cy = e\.clientY - rect\.top;\s*const w = rect\.width;\s*const h = rect\.height;\s*const padX = 8;\s*const padY = 10;\s*const isCompact = w < 220;\s*const dialsW = isCompact \? 0 : Math\.min\(80, w \* 0\.28\);\s*const bandW = w - 2 \* padX - dialsW;\s*const lowFreq = p\.lowFreq \?\? 250;\s*const highFreq = p\.highFreq \?\? 2500;\s*const xLow = padX \+ \(0\.15 \+ lowToPos\(lowFreq\) \* 0\.3\) \* bandW;\s*const xHigh = padX \+ \(0\.5 \+ highToPos\(highFreq\) \* 0\.45\) \* bandW;).*?(if \(Math\.abs\(cx - xLow\) < 14\) \{)"

new_on_down = r"""\1
        const x0 = padX;
        const xRight = padX + bandW;
        
        \2"""
content = re.sub(on_down_compressor_regex, new_on_down, content, flags=re.DOTALL)

# Now fix the floor / ceiling / amount logic in onDown
on_down_floor = r"(// Independent Band Floor Dragging:\s*)(if \(cx < xLow\) \{.*?\})"
new_on_down_floor = r"""\1
        const b = cx < xLow ? 'low' : cx < xHigh ? 'mid' : 'high';
        const bCx = cx < xLow ? (x0 + xLow)/2 : cx < xHigh ? (xLow + xHigh)/2 : (xHigh + xRight)/2;
        const pFloor = cx < xLow ? p.lowFloorDb : cx < xHigh ? p.midFloorDb : p.highFloorDb;
        const pCeil = cx < xLow ? p.lowCeilingDb : cx < xHigh ? p.midCeilingDb : p.highCeilingDb;
        const pAmt = cx < xLow ? p.lowAmount : cx < xHigh ? p.midAmount : p.highAmount;
        
        if (Math.hypot(cx - bCx, cy - h/2) < 18) {
            drag.current = { mode: (b + 'Amount') as any, startY: e.clientY, base: pAmt ?? 0.5 };
        } else if (cy < h/2 - 10) {
            drag.current = { mode: (b + 'CeilingDb') as any, startY: e.clientY, base: pCeil ?? -12 };
        } else {
            drag.current = { mode: (b + 'FloorDb') as any, startY: e.clientY, base: pFloor ?? -80 };
        }
        return;"""
content = re.sub(on_down_floor, new_on_down_floor, content, flags=re.DOTALL)


# 3. Update hit testing in onMove for compressor (hover detection)
on_move_hover = r"(let hTarget: string \| null = null;).*?(if \(\!hTarget\) \{.*?else hTarget = 'highFloorDb';\s*\})"

new_on_move_hover = r"""\1
          const x0 = padX;
          const xRight = padX + bandW;
          
          if (Math.abs(cx - xLow) < 14) hTarget = 'lowFreq';
          else if (Math.abs(cx - xHigh) < 14) hTarget = 'highFreq';
          else {
            const b = cx < xLow ? 'low' : cx < xHigh ? 'mid' : 'high';
            const bCx = cx < xLow ? (x0 + xLow)/2 : cx < xHigh ? (xLow + xHigh)/2 : (xHigh + xRight)/2;
            if (Math.hypot(cx - bCx, cy - h/2) < 18) hTarget = b + 'Amount';
            else if (cy < h/2 - 10) hTarget = b + 'CeilingDb';
            else hTarget = b + 'FloorDb';
          }"""
content = re.sub(on_move_hover, new_on_move_hover, content, flags=re.DOTALL)

# 4. Add handlers for CeilingDb and Amount dragging in onMove
# It's currently in an `else if (d.mode === ('lowFloorDb' as any))` chain.
# I will just write a snippet that replaces the whole 'attack', 'release' and floor chain if it's there, or adds to it.
# Actually let's just append the new modes to the chain.
# Wait, I need to remove attack and release from onMove too!
drag_handlers = r"if \(d\.mode === \('attack' as any\)\) \{.*?\} else if \(d\.mode === \('release' as any\)\) \{.*?\} else if \(d\.mode === \('lowFreq' as any\)\) \{"

new_drag_handlers = r"if (d.mode === ('lowFreq' as any)) {"
content = re.sub(drag_handlers, new_drag_handlers, content, flags=re.DOTALL)

# Now add Target and Amount handlers to the chain. The chain ends with highFloorDb.
floor_drag = r"\} else if \(d\.mode === \('highFloorDb' as any\)\) \{\s*const dy = d\.startY - e\.clientY;\s*onChange\(\{ highFloorDb: Math\.max\(-80, Math\.min\(0, d\.base \+ dy / 2\)\) \}\);\s*\}"

new_floor_drag = r"""} else if (d.mode === ('highFloorDb' as any)) {
          const dy = d.startY - e.clientY;
          onChange({ highFloorDb: Math.max(-80, Math.min(0, d.base + dy / 2)) });
        } else if (d.mode.endsWith('CeilingDb')) {
          const dy = d.startY - e.clientY;
          const band = d.mode.replace('CeilingDb', '');
          onChange({ [d.mode]: Math.max(-80, Math.min(0, d.base + dy / 2)) });
        } else if (d.mode.endsWith('Amount')) {
          const dy = d.startY - e.clientY;
          const band = d.mode.replace('Amount', '');
          onChange({ [d.mode]: Math.max(0, Math.min(1, d.base + dy / 150)) });
        }"""
content = re.sub(floor_drag, new_floor_drag, content, flags=re.DOTALL)


with open("spike/elementary/ui/FxViz.tsx", "w", encoding="utf-8") as f:
    f.write(content)
print("done")
