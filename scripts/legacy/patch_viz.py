import re

with open("spike/elementary/ui/FxViz.tsx", "r", encoding="utf-8") as f:
    content = f.read()

draw_func_pattern = re.compile(
    r"function drawMultibandCompressor\(.*?\n\}\n\nfunction drawNumberDial",
    re.DOTALL
)

def build_draw_func():
    return """function drawMultibandCompressor(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  p: CompressorFxSettings,
  lvl: number,
  hoverTarget: string | null,
  dragTarget: string | null
) {
  const lowFreq = p.lowFreq ?? 250;
  const highFreq = p.highFreq ?? 2500;

  const lowFloorDb = p.lowFloorDb ?? -80;
  const midFloorDb = p.midFloorDb ?? -80;
  const highFloorDb = p.highFloorDb ?? -80;

  const lowCeilingDb = p.lowCeilingDb ?? -12;
  const midCeilingDb = p.midCeilingDb ?? -12;
  const highCeilingDb = p.highCeilingDb ?? -12;

  const lowAmount = p.lowAmount ?? 0.5;
  const midAmount = p.midAmount ?? 0.5;
  const highAmount = p.highAmount ?? 0.5;

  const lowAtk = p.lowAttackMs ?? 10;
  const lowRel = p.lowReleaseMs ?? 120;

  const padX = 8;
  const padY = 10;
  const isCompact = w < 220;
  const dialsW = isCompact ? 0 : Math.min(80, w * 0.28);
  const bandW = w - 2 * padX - dialsW;

  const x0 = padX;
  const xLow = padX + (0.15 + lowToPos(lowFreq) * 0.3) * bandW;
  const xHigh = padX + (0.5 + highToPos(highFreq) * 0.45) * bandW;
  const xRight = padX + bandW;

  const floorToY = (floorDb: number) => (h - padY) - dbToYNorm(floorDb) * (h - 2 * padY);
  const targetToY = (ceilingDb: number) => (h - padY) - dbToYNorm(ceilingDb) * (h - 2 * padY);

  const bands = [
    { name: 'LOW', id: 'low', xStart: x0, xEnd: xLow, floorDb: lowFloorDb, ceilingDb: lowCeilingDb, amount: lowAmount, color: '#38bdf8', lvlMult: 0.85 },
    { name: 'MID', id: 'mid', xStart: xLow + 2, xEnd: xHigh - 2, floorDb: midFloorDb, ceilingDb: midCeilingDb, amount: midAmount, color: '#ec4899', lvlMult: 1.1 },
    { name: 'HIGH', id: 'high', xStart: xHigh + 2, xEnd: xRight, floorDb: highFloorDb, ceilingDb: highCeilingDb, amount: highAmount, color: '#fbbf24', lvlMult: 0.75 },
  ];

  ctx.save();

  // 1. Column Backgrounds & Independent Floor Lines
  for (const b of bands) {
    const bw = Math.max(8, b.xEnd - b.xStart);
    const isHovered = hoverTarget && hoverTarget.startsWith(b.id);
    const isFloorHovered = hoverTarget === `${b.id}FloorDb` || dragTarget === `${b.id}FloorDb`;
    const isTargetHovered = hoverTarget === `${b.id}CeilingDb` || dragTarget === `${b.id}CeilingDb`;
    const isAmtHovered = hoverTarget === `${b.id}Amount` || dragTarget === `${b.id}Amount`;

    // Card background
    ctx.fillStyle = isHovered ? 'rgba(35, 25, 55, 0.85)' : 'rgba(20, 14, 32, 0.75)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(b.xStart, padY, bw, h - 2 * padY, 4);
    else ctx.rect(b.xStart, padY, bw, h - 2 * padY);
    ctx.fill();
    ctx.strokeStyle = isHovered ? b.color : 'rgba(236, 72, 153, 0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Shaded horizontal gridlines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    for (let y = padY + 10; y < h - padY; y += 10) {
      ctx.beginPath(); ctx.moveTo(b.xStart, y); ctx.lineTo(b.xEnd, y); ctx.stroke();
    }

    // Level meter bars
    const bLvl = Math.min(1, lvl * b.lvlMult);
    const barH = bLvl * (h - 2 * padY - 12);
    const barW = Math.max(4, Math.min(12, bw * 0.18));
    const cx = (b.xStart + b.xEnd) / 2;

    for (const offset of [-barW - 1, 1]) {
      const bx = cx + offset;
      const by = h - padY - barH;
      const grad = ctx.createLinearGradient(0, h - padY, 0, padY);
      grad.addColorStop(0, b.color);
      grad.addColorStop(1.0, '#ffffff');
      ctx.fillStyle = grad;
      ctx.fillRect(bx, by, barW, barH);
    }

    // INDEPENDENT Floor Line for this band
    const fy = floorToY(b.floorDb);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = isFloorHovered ? 2.5 : 1.8;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = isFloorHovered ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(b.xStart, fy);
    ctx.lineTo(b.xEnd, fy);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // TARGET (Ceiling) Line
    const ty = targetToY(b.ceilingDb);
    ctx.strokeStyle = b.color;
    ctx.lineWidth = isTargetHovered ? 2.5 : 1.8;
    ctx.shadowColor = b.color;
    ctx.shadowBlur = isTargetHovered ? 8 : 4;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(b.xStart, ty);
    ctx.lineTo(b.xEnd, ty);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Band Name & Floor dB Badge
    ctx.font = 'bold 8px monospace';
    ctx.fillStyle = isHovered ? '#ffffff' : b.color;
    ctx.textAlign = 'left';
    ctx.fillText(`${b.name}`, b.xStart + 3, padY + 10);

    const badgeStr = `${b.floorDb.toFixed(0)}dB`;
    const targetBadgeStr = `${b.ceilingDb.toFixed(0)}dB`;
    const badgeW = Math.min(bw - 4, 38);
    if (badgeW > 16) {
      // Floor badge
      ctx.fillStyle = 'rgba(10, 8, 18, 0.85)';
      ctx.fillRect(b.xStart + 2, Math.max(padY + 12, fy - 11), badgeW, 10);
      ctx.strokeStyle = b.color;
      ctx.lineWidth = 1;
      ctx.strokeRect(b.xStart + 2, Math.max(padY + 12, fy - 11), badgeW, 10);
      ctx.fillStyle = '#ffffff';
      ctx.font = '7px monospace';
      ctx.fillText(badgeStr, b.xStart + 4, Math.max(padY + 20, fy - 3));

      // Target badge
      ctx.fillStyle = 'rgba(10, 8, 18, 0.85)';
      ctx.fillRect(b.xStart + 2, Math.max(padY + 12, ty - 11), badgeW, 10);
      ctx.strokeRect(b.xStart + 2, Math.max(padY + 12, ty - 11), badgeW, 10);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(targetBadgeStr, b.xStart + 4, Math.max(padY + 20, ty - 3));
    }

    // AMOUNT Knob
    if (bw > 36) {
      const knobY = h / 2;
      drawNumberDial(ctx, cx, knobY, 'AMT', `${Math.round(b.amount * 100)}%`, b.amount, isAmtHovered, b.color, '0.15');
    }
  }

  // 2. Crossover Vertical Lines
  for (const { x, freq, label, id } of [
    { x: xLow, freq: lowFreq, label: `${Math.round(lowFreq)}Hz`, id: 'lowFreq' },
    { x: xHigh, freq: highFreq, label: highFreq >= 1000 ? `${(highFreq / 1000).toFixed(1)}k` : `${Math.round(highFreq)}Hz`, id: 'highFreq' },
  ]) {
    const isHovered = hoverTarget === id || dragTarget === id;
    ctx.strokeStyle = isHovered ? '#ffffff' : 'rgba(236, 72, 153, 0.6)';
    ctx.lineWidth = isHovered ? 2 : 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x, padY); ctx.lineTo(x, h - padY); ctx.stroke();
    ctx.setLineDash([]);

    // Crossover handle dot
    ctx.fillStyle = isHovered ? '#ffffff' : '#ec4899';
    ctx.beginPath(); ctx.arc(x, h / 2, isHovered ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();

    // Crossover freq label
    ctx.font = '7px monospace';
    ctx.fillStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.6)';
    ctx.textAlign = 'center';
    ctx.fillText(label, x, h - 2);
  }

  // 3. Attack & Release Numeric Dials (Right Side Area when non-compact)
  if (!isCompact && dialsW > 40) {
    const dialX = w - dialsW / 2 - padX / 2;
    const attackY = padY + (h - 2 * padY) * 0.28;
    const releaseY = padY + (h - 2 * padY) * 0.72;

    drawNumberDial(ctx, dialX, attackY, 'ATTACK', `${Math.round(lowAtk)}ms`, attackToPos(lowAtk), hoverTarget === 'attack' || dragTarget === 'attack');
    drawNumberDial(ctx, dialX, releaseY, 'RELEASE', `${Math.round(lowRel)}ms`, releaseToPos(lowRel), hoverTarget === 'release' || dragTarget === 'release');
  }

  ctx.restore();
}

function drawNumberDial"""

content = draw_func_pattern.sub(build_draw_func(), content)

# Now, let's update the hit testing logic in useSynthViz

hit_test_old = """        // Independent Band Floor Dragging:
        if (cx < xLow) {
          drag.current = { mode: 'lowFloorDb' as any, startY: e.clientY, base: p.lowFloorDb ?? -80 };
        } else if (cx < xHigh) {
          drag.current = { mode: 'midFloorDb' as any, startY: e.clientY, base: p.midFloorDb ?? -80 };
        } else {
          drag.current = { mode: 'highFloorDb' as any, startY: e.clientY, base: p.highFloorDb ?? -80 };
        }
        return;"""

hit_test_new = """        // Independent Band Interactions (Amount, Target, Floor):
        const bandId = cx < xLow ? 'low' : cx < xHigh ? 'mid' : 'high';
        const bandCx = cx < xLow ? padX + (xLow - padX) / 2 : cx < xHigh ? xLow + (xHigh - xLow) / 2 : xHigh + (w - padX - dialsW - xHigh) / 2;
        
        // Check Amount dial
        if (Math.hypot(cx - bandCx, cy - h / 2) < 20) {
          drag.current = { mode: `${bandId}Amount` as any, startY: e.clientY, base: (p as any)[`${bandId}Amount`] ?? 0.5 };
          return;
        }
        
        const floorDb = (p as any)[`${bandId}FloorDb`] ?? -80;
        const targetDb = (p as any)[`${bandId}CeilingDb`] ?? -12;
        const floorY = (h - padY) - dbToYNorm(floorDb) * (h - 2 * padY);
        const targetY = (h - padY) - dbToYNorm(targetDb) * (h - 2 * padY);
        
        if (Math.abs(cy - targetY) < 14) {
          drag.current = { mode: `${bandId}CeilingDb` as any, startY: e.clientY, base: targetDb };
        } else {
          // Default to floor drag if clicking in band (or if near floor)
          drag.current = { mode: `${bandId}FloorDb` as any, startY: e.clientY, base: floorDb };
        }
        return;"""

content = content.replace(hit_test_old, hit_test_new)

hover_test_old = """          if (!hTarget) {
            if (Math.abs(cx - xLow) < 14) hTarget = 'lowFreq';
            else if (Math.abs(cx - xHigh) < 14) hTarget = 'highFreq';
            else if (cx < xLow) hTarget = 'lowFloorDb';
            else if (cx < xHigh) hTarget = 'midFloorDb';
            else hTarget = 'highFloorDb';
          }"""

hover_test_new = """          if (!hTarget) {
            if (Math.abs(cx - xLow) < 14) hTarget = 'lowFreq';
            else if (Math.abs(cx - xHigh) < 14) hTarget = 'highFreq';
            else {
              const bandId = cx < xLow ? 'low' : cx < xHigh ? 'mid' : 'high';
              const bandCx = cx < xLow ? padX + (xLow - padX) / 2 : cx < xHigh ? xLow + (xHigh - xLow) / 2 : xHigh + (w - padX - dialsW - xHigh) / 2;
              const floorDb = (p as any)[`${bandId}FloorDb`] ?? -80;
              const targetDb = (p as any)[`${bandId}CeilingDb`] ?? -12;
              const floorY = (h - padY) - dbToYNorm(floorDb) * (h - 2 * padY);
              const targetY = (h - padY) - dbToYNorm(targetDb) * (h - 2 * padY);
              
              if (Math.hypot(cx - bandCx, cy - h / 2) < 20) hTarget = `${bandId}Amount`;
              else if (Math.abs(cy - targetY) < 14) hTarget = `${bandId}CeilingDb`;
              else hTarget = `${bandId}FloorDb`;
            }
          }"""

content = content.replace(hover_test_old, hover_test_new)

move_test_old = """        } else if (d.mode === ('midFloorDb' as any)) {
          const newDb = Math.max(-120, Math.min(-12, d.base + dy * 0.5));
          onChange({ midFloorDb: newDb });
        } else if (d.mode === ('highFloorDb' as any)) {
          const newDb = Math.max(-120, Math.min(-12, d.base + dy * 0.5));
          onChange({ highFloorDb: newDb });
        }"""

move_test_new = """        } else if (d.mode === ('midFloorDb' as any)) {
          const newDb = Math.max(-120, Math.min(-12, d.base + dy * 0.5));
          onChange({ midFloorDb: newDb });
        } else if (d.mode === ('highFloorDb' as any)) {
          const newDb = Math.max(-120, Math.min(-12, d.base + dy * 0.5));
          onChange({ highFloorDb: newDb });
        } else if (d.mode.endsWith('CeilingDb')) {
          const newDb = Math.max(-60, Math.min(0, d.base + dy * 0.5));
          onChange({ [d.mode]: newDb });
        } else if (d.mode.endsWith('Amount')) {
          const newAmt = Math.max(0, Math.min(1, d.base + dy * 0.005));
          onChange({ [d.mode]: newAmt });
        }"""

content = content.replace(move_test_old, move_test_new)

with open("spike/elementary/ui/FxViz.tsx", "w", encoding="utf-8") as f:
    f.write(content)

print("Patched FxViz.tsx successfully")
