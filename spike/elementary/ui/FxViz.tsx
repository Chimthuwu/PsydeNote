// FX "Sonic Material" physics canvas (todo.md §80/§84/§86). One component,
// two physics models — reverb = an expanding reflection field in a chamber,
// delay = discrete echo rings marching out from the source. Condensed from
// the prototypes in spike/elementary/design/*.html.
//
// Plugin canvas rules (§73/§74): opt-in `data-allow-2d`, ONE throttled rAF
// loop, NO ResizeObserver (rect is read per frame). The canvas is also a
// control — drag = Size/Decay (reverb) or Time (delay).
//
// Distortion and Chorus keep the 2D node-handle graphic UI (mix node:
// bottom-left = 0% dry, top-right = 100% wet, plus per-node params). Flanger
// and Phaser were upgraded to a Vital-style animated frequency-response
// curve (drawVitalResponse): the curve IS the effect's real transfer function
// (a feedback comb of notches swept by the LFO) — drag = rate/depth,
// Shift-drag = feedback, Alt-drag = stages (phaser) or mix/width (flanger).
import { useEffect, useRef } from 'react';
import type { ChorusFxSettings, CompressorFxSettings, DelayFxSettings, DistortionFxSettings, FlangerFxSettings, PhaserFxSettings, ReverbFxSettings } from '../../../src/shared/types';
import { getScopeRms, getVizGain } from './scopeStore';

type Kind = 'reverb' | 'delay' | 'distortion' | 'chorus' | 'flanger' | 'compressor' | 'phaser';

interface Props {
  kind: Kind;
  /** The effect's params (slice of FxSettings). */
  params: ReverbFxSettings | DelayFxSettings | DistortionFxSettings | ChorusFxSettings | FlangerFxSettings | CompressorFxSettings | PhaserFxSettings;
  onChange: (patch: Record<string, number | boolean>) => void;
  /** Fallback 0..1 level for a plain browser (no native scope). The canvas
   *  prefers the live post-FX `main` scope RMS when it's flowing. */
  level: number;
  /** Bumped on every note-on — spawns a reflection burst. */
  trigger: number;
}

const DAMP_STOPS = [
  { t: 0, h: 165, s: 88, l: 78 },
  { t: 0.35, h: 205, s: 78, l: 55 },
  { t: 0.7, h: 248, s: 62, l: 34 },
  { t: 1, h: 278, s: 48, l: 16 },
];
function palette(damp: number) {
  // damp 0 (open/bright) -> the bright teal stop, damp 1 (dark) -> the dark purple stop.
  const cut = Math.max(0, Math.min(1, damp));
  let a = DAMP_STOPS[0];
  let b = DAMP_STOPS[DAMP_STOPS.length - 1];
  for (let i = 0; i < DAMP_STOPS.length - 1; i += 1) {
    if (cut >= DAMP_STOPS[i].t && cut <= DAMP_STOPS[i + 1].t) { a = DAMP_STOPS[i]; b = DAMP_STOPS[i + 1]; break; }
  }
  const u = (cut - a.t) / ((b.t - a.t) || 1);
  return { h: a.h + (b.h - a.h) * u, s: a.s + (b.s - a.s) * u, l: a.l + (b.l - a.l) * u };
}

interface Ring { born: number; amp: number; ox: number; oy: number; idx: number }

const R_MIN = 0.05;
const R_MAX = 5;
const rateToPos = (v: number) => Math.log(Math.max(R_MIN, Math.min(R_MAX, v)) / R_MIN) / Math.log(R_MAX / R_MIN);
const posToRate = (p: number) => R_MIN * Math.pow(R_MAX / R_MIN, Math.max(0, Math.min(1, p)));

const PAD_X = 6;
const PAD_Y = 6;

const LOW_MIN = 100;
const LOW_MAX = 800;
const lowToPos = (hzVal: number) => (Math.max(LOW_MIN, Math.min(LOW_MAX, hzVal)) - LOW_MIN) / (LOW_MAX - LOW_MIN);
const posToLow = (p: number) => LOW_MIN + Math.max(0, Math.min(1, p)) * (LOW_MAX - LOW_MIN);

const HIGH_MIN = 1000;
const HIGH_MAX = 10000;
const highToPos = (hzVal: number) => Math.log(Math.max(HIGH_MIN, Math.min(HIGH_MAX, hzVal)) / HIGH_MIN) / Math.log(HIGH_MAX / HIGH_MIN);
const posToHigh = (p: number) => HIGH_MIN * Math.pow(HIGH_MAX / HIGH_MIN, Math.max(0, Math.min(1, p)));

const ATTACK_MIN = 1;
const ATTACK_MAX = 100;
const attackToPos = (ms: number) => Math.log(Math.max(ATTACK_MIN, Math.min(ATTACK_MAX, ms)) / ATTACK_MIN) / Math.log(ATTACK_MAX / ATTACK_MIN);
const posToAttack = (p: number) => ATTACK_MIN * Math.pow(ATTACK_MAX / ATTACK_MIN, Math.max(0, Math.min(1, p)));

const REL_MIN = 20;
const REL_MAX = 1000;
const releaseToPos = (ms: number) => Math.log(Math.max(REL_MIN, Math.min(REL_MAX, ms)) / REL_MIN) / Math.log(REL_MAX / REL_MIN);
const posToRelease = (p: number) => REL_MIN * Math.pow(REL_MAX / REL_MIN, Math.max(0, Math.min(1, p)));

const dbToYNorm = (db: number) => Math.max(0, Math.min(1, (db - (-120)) / (-12 - (-120))));
const yNormToDb = (pos: number) => -120 + Math.max(0, Math.min(1, pos)) * 108;

function drawMultibandCompressor(
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

  const lowFloorDb = p.lowFloorDb ?? -55;
  const midFloorDb = p.midFloorDb ?? -55;
  const highFloorDb = p.highFloorDb ?? -55;

  const lowCeilingDb = p.lowCeilingDb ?? -12;
  const midCeilingDb = p.midCeilingDb ?? -12;
  const highCeilingDb = p.highCeilingDb ?? -12;

  const lowAmount = p.lowAmount ?? 0.5;
  const midAmount = p.midAmount ?? 0.5;
  const highAmount = p.highAmount ?? 0.5;

  const padX = 8;
  const padY = 10;
  const isCompact = w < 220;
  // Attack/Release dials are gone (the header faders own them) — bands use the full width.
  const dialsW = 0;
  const bandW = w - 2 * padX - dialsW;

  const x0 = padX;
  const xLow = padX + (0.15 + lowToPos(lowFreq) * 0.3) * bandW;
  const xHigh = padX + (0.5 + highToPos(highFreq) * 0.45) * bandW;
  const xRight = padX + bandW;

  const floorToY = (floorDb: number) => (h - padY) - dbToYNorm(floorDb) * (h - 2 * padY);
  // Ceiling has its own -24..0 dB scale (the param's real range), so it can be dragged anywhere.
  const targetToY = (ceilingDb: number) => (h - padY) - Math.max(0, Math.min(1, (ceilingDb + 24) / 24)) * (h - 2 * padY);

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

  ctx.restore();
}

function drawNumberDial(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  label: string,
  valStr: string,
  pos: number,
  isHovered: boolean,
  color: string = '#ec4899',
  alphaStr: string = '0.4'
) {
  ctx.save();
  ctx.translate(x, y);

  // Outer ring
  const r = 16;
  ctx.globalAlpha = isHovered ? 1.0 : parseFloat(alphaStr);
  ctx.strokeStyle = isHovered ? '#ffffff' : color;
  ctx.lineWidth = isHovered ? 3 : 2;
  ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1.0;

  // Active value arc
  const startAng = Math.PI * 0.75;
  const endAng = Math.PI * 0.75 + pos * Math.PI * 1.5;
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = isHovered ? 6 : 0;
  ctx.beginPath(); ctx.arc(0, 0, r, startAng, endAng); ctx.stroke();
  ctx.shadowBlur = 0;

  // Center indicator dot
  ctx.fillStyle = isHovered ? '#ffffff' : color;
  ctx.beginPath(); ctx.arc(0, 0, 3, 0, Math.PI * 2); ctx.fill();

  // Label (top)
  ctx.font = '6px monospace';
  ctx.fillStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.5)';
  ctx.textAlign = 'center';
  ctx.fillText(label, 0, -20);

  // Value (bottom)
  ctx.font = 'bold 8px monospace';
  ctx.fillStyle = isHovered ? '#ffffff' : 'rgba(255, 255, 255, 0.8)';
  ctx.fillText(valStr, 0, 26);

  ctx.restore();
}

interface FxNodeSpec {
  id: string;
  name: string;
  nx: number;
  ny: number;
  isMixNode?: boolean;
  label: string;
}

function getNodesForDistortion(p: DistortionFxSettings): FxNodeSpec[] {
  const drive = Math.max(0, Math.min(1, p.drive ?? 0.35));
  const tone = Math.max(0, Math.min(1, p.tone ?? 0.7));
  return [
    {
      id: 'drive',
      name: 'DRIVE',
      nx: drive,
      ny: 0.3 + 0.5 * drive,
      label: `DRIVE ${Math.round(drive * 100)}%`,
    },
    {
      id: 'tone',
      name: 'TONE',
      nx: tone,
      ny: 0.75 - 0.5 * tone,
      label: `TONE ${Math.round(tone * 100)}%`,
    },
  ];
}

function getNodesForChorus(p: ChorusFxSettings): FxNodeSpec[] {
  const width = Math.max(0, Math.min(1, p.width ?? 0.65));
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.8));
  const depth = Math.max(0, Math.min(1, p.depth ?? 0.45));
  return [
    {
      id: 'rate-depth',
      name: 'RATE / DEPTH',
      nx: rateToPos(rate),
      ny: depth,
      label: `RATE ${rate.toFixed(2)}Hz · DEPTH ${Math.round(depth * 100)}%`,
    },
    {
      id: 'width',
      name: 'WIDTH',
      nx: width,
      ny: 0.25 + 0.5 * width,
      label: `WIDTH ${Math.round(width * 100)}%`,
    },
  ];
}

function getNodesForFlanger(p: FlangerFxSettings): FxNodeSpec[] {
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.5));
  const depth = Math.max(0, Math.min(1, p.depth ?? 0.55));
  const fb = Math.max(0, Math.min(0.9, p.feedback ?? 0.45));
  return [
    {
      id: 'rate-depth',
      name: 'RATE / DEPTH',
      nx: rateToPos(rate),
      ny: depth,
      label: `RATE ${rate.toFixed(2)}Hz · DEPTH ${Math.round(depth * 100)}%`,
    },
    {
      id: 'feedback',
      name: 'FEEDBACK',
      nx: Math.min(1, Math.max(0, fb / 0.9)),
      ny: 0.25 + 0.5 * (fb / 0.9),
      label: `FEEDBACK ${Math.round(fb * 100)}%`,
    },
  ];
}

function getNodesForPhaser(p: PhaserFxSettings): FxNodeSpec[] {
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.35));
  const depth = Math.max(0, Math.min(1, p.depth ?? 0.65));
  const fb = Math.max(0, Math.min(0.9, p.feedback ?? 0.35));
  const stages = Math.round(p.stages ?? 4);
  const stagesPos = Math.min(1, Math.max(0, (stages - 2) / 6));
  return [
    {
      id: 'rate-depth',
      name: 'RATE / DEPTH',
      nx: rateToPos(rate),
      ny: depth,
      label: `RATE ${rate.toFixed(2)}Hz · DEPTH ${Math.round(depth * 100)}%`,
    },
    {
      id: 'stages-fb',
      name: 'STAGES / FB',
      nx: stagesPos,
      ny: Math.min(1, Math.max(0, fb / 0.9)),
      label: `STAGES ${stages} · FB ${Math.round(fb * 100)}%`,
    },
  ];
}

const DT_MIN = 1;
const DT_MAX = 2000;
const timeToPos = (ms: number) => Math.log(Math.max(DT_MIN, Math.min(DT_MAX, ms)) / DT_MIN) / Math.log(DT_MAX / DT_MIN);
const posToTime = (p: number) => DT_MIN * Math.pow(DT_MAX / DT_MIN, Math.max(0, Math.min(1, p)));
const fmtTime = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
const pc = (v: number) => `${Math.round(v * 100)}%`;
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

function getNodesForDelay(p: DelayFxSettings): FxNodeSpec[] {
  const time = p.timeMs ?? 300;
  const fb = Math.max(0, Math.min(0.95, p.feedback ?? 0.4));
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.5));
  const mod = clamp01(p.mod ?? 0);
  const width = clamp01(p.width ?? 0.5);
  const diff = clamp01(p.diffusion ?? 0);
  const lo = clamp01(p.locut ?? 0);
  const hi = clamp01(p.tone ?? 0.7);
  return [
    { id: 'time-fb', name: 'TIME / FEEDBACK', nx: timeToPos(time), ny: fb / 0.95, label: `TIME ${fmtTime(time)} · FB ${pc(fb)}` },
    { id: 'rate-mod', name: 'RATE / MOD', nx: rateToPos(rate), ny: mod, label: `RATE ${rate.toFixed(2)}Hz · MOD ${pc(mod)}` },
    { id: 'width-diff', name: 'WIDTH / DIFF', nx: width, ny: diff, label: `WIDTH ${pc(width)} · DIFF ${pc(diff)}` },
    { id: 'cut', name: 'LOCUT / HICUT', nx: lo, ny: hi, label: `LOCUT ${pc(lo)} · HICUT ${pc(hi)}` },
  ];
}

function getNodesForReverb(p: ReverbFxSettings): FxNodeSpec[] {
  const size = clamp01(p.size ?? 0.5);
  const decay = clamp01(p.decay ?? 0.5);
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.5));
  const mod = clamp01(p.mod ?? 0);
  const width = clamp01(p.width ?? 0.7);
  const diff = clamp01(p.diffusion ?? 0.5);
  const lo = clamp01(p.locut ?? 0);
  const damp = clamp01(p.damp ?? 0.5);
  return [
    { id: 'size-decay', name: 'SIZE / DECAY', nx: size, ny: decay, label: `SIZE ${pc(size)} · DECAY ${pc(decay)}` },
    { id: 'rate-mod', name: 'RATE / MOD', nx: rateToPos(rate), ny: mod, label: `RATE ${rate.toFixed(2)}Hz · MOD ${pc(mod)}` },
    { id: 'width-diff', name: 'WIDTH / DIFF', nx: width, ny: diff, label: `WIDTH ${pc(width)} · DIFF ${pc(diff)}` },
    { id: 'cut', name: 'LOCUT / DAMP', nx: lo, ny: damp, label: `LOCUT ${pc(lo)} · DAMP ${pc(damp)}` },
  ];
}

type NodeKind = 'distortion' | 'chorus' | 'flanger' | 'phaser' | 'delay' | 'reverb';
const isNodeKind = (k: string): k is NodeKind =>
  k === 'distortion' || k === 'chorus' || k === 'flanger' || k === 'phaser' || k === 'delay' || k === 'reverb';

function getFxNodes(kind: NodeKind, p: any): FxNodeSpec[] {
  if (kind === 'distortion') return getNodesForDistortion(p);
  if (kind === 'chorus') return getNodesForChorus(p);
  if (kind === 'flanger') return getNodesForFlanger(p);
  if (kind === 'delay') return getNodesForDelay(p);
  if (kind === 'reverb') return getNodesForReverb(p);
  return getNodesForPhaser(p);
}

function drawNodeOverlayHandles(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  nodes: FxNodeSpec[],
  hoverId: string | null,
  dragId: string | null,
  palIn: { h: number; s: number; l: number } | ((n: FxNodeSpec) => { h: number; s: number; l: number })
) {
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const pal = typeof palIn === 'function' ? palIn(node) : palIn;
    const ncx = PAD_X + node.nx * (w - 2 * PAD_X);
    const ncy = (h - PAD_Y) - node.ny * (h - 2 * PAD_Y);

    const isHovered = hoverId === node.id;
    const isDragged = dragId === node.id;

    const ringR = isDragged ? 11 : isHovered ? 10 : 8;
    const haloR = isDragged ? 24 : isHovered ? 20 : 14;

    // Radial glow
    const glow = ctx.createRadialGradient(ncx, ncy, 0, ncx, ncy, haloR);
    glow.addColorStop(0, `hsla(${pal.h}, ${pal.s}%, ${Math.min(94, pal.l + 25)}%, ${isDragged ? 0.6 : isHovered ? 0.45 : 0.25})`);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.arc(ncx, ncy, haloR, 0, Math.PI * 2); ctx.fill();

    // Ring
    ctx.strokeStyle = `hsla(${pal.h}, ${pal.s}%, ${Math.min(96, pal.l + 30)}%, ${isDragged || isHovered ? 1.0 : 0.8})`;
    ctx.lineWidth = isDragged ? 2.5 : isHovered ? 2 : 1.5;
    ctx.beginPath(); ctx.arc(ncx, ncy, ringR, 0, Math.PI * 2); ctx.stroke();

    // Core dot
    ctx.fillStyle = isDragged || isHovered ? '#ffffff' : `hsla(${pal.h}, ${pal.s}%, 90%, 0.9)`;
    ctx.beginPath(); ctx.arc(ncx, ncy, 3.5, 0, Math.PI * 2); ctx.fill();

    // Label badge box
    ctx.font = 'bold 9px monospace';
    const txt = node.label;
    const tw = ctx.measureText(txt).width;
    const bw = tw + 10;
    const bh = 15;

    const bx = Math.max(bw / 2 + 2, Math.min(w - bw / 2 - 2, ncx));
    const by = ncy < 35 ? ncy + 15 : ncy - 18;

    // Badge background
    ctx.fillStyle = 'rgba(6, 10, 20, 0.85)';
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(bx - bw / 2, by - bh / 2, bw, bh, 3);
    } else {
      ctx.rect(bx - bw / 2, by - bh / 2, bw, bh);
    }
    ctx.fill();

    // Badge border
    ctx.strokeStyle = `hsla(${pal.h}, ${pal.s}%, ${Math.min(88, pal.l + 20)}%, 0.6)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    // Badge text
    ctx.fillStyle = '#f0f4fc';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, bx, by);
  }
}

/** Layout shared by the compressor's drawing and its hit-testing. */
function compressorGeom(p: CompressorFxSettings, w: number, h: number) {
  const padX = 8;
  const padY = 10;
  const bandW = w - 2 * padX; // no attack/release dials any more
  const xLow = padX + (0.15 + lowToPos(p.lowFreq ?? 250) * 0.3) * bandW;
  const xHigh = padX + (0.5 + highToPos(p.highFreq ?? 2500) * 0.45) * bandW;
  return { padX, padY, h, xLow, xHigh, x0: padX, xRight: padX + bandW };
}
const COMP_FLOOR_RANGE: [number, number] = [-120, -12];
const COMP_CEIL_RANGE: [number, number] = [-24, 0];
const yToNorm = (y: number, h: number, padY: number) => clamp01(((h - padY) - y) / (h - 2 * padY));
// dB <-> y share one scale (dbToYNorm: -120..-12 -> 0..1), so a line sits under the cursor.
const compYToDb = (y: number, h: number, padY: number) => yNormToDb(yToNorm(y, h, padY));

/** What the pointer is over: a crossover, a band's AMT knob, its ceiling or its floor ("threshold") line. */
function compressorTargetAt(p: CompressorFxSettings, cx: number, cy: number, w: number, h: number): string | null {
  const g = compressorGeom(p, w, h);
  if (cx < g.x0 - 2 || cx > g.xRight + 2) return null;
  if (Math.abs(cx - g.xLow) < 10) return 'lowFreq';
  if (Math.abs(cx - g.xHigh) < 10) return 'highFreq';
  const id = cx < g.xLow ? 'low' : cx < g.xHigh ? 'mid' : 'high';
  const bx0 = id === 'low' ? g.x0 : id === 'mid' ? g.xLow : g.xHigh;
  const bx1 = id === 'low' ? g.xLow : id === 'mid' ? g.xHigh : g.xRight;
  if (Math.hypot(cx - (bx0 + bx1) / 2, cy - h / 2) < 18) return `${id}Amount`;
  const floorDb = (p as any)[`${id}FloorDb`] ?? -55;
  const ceilDb = (p as any)[`${id}CeilingDb`] ?? -12;
  const yFloor = (db: number) => (h - g.padY) - dbToYNorm(db) * (h - 2 * g.padY);
  const yCeil = (db: number) => (h - g.padY) - clamp01((db + 24) / 24) * (h - 2 * g.padY);
  // The nearer of the two lines wins, so each is grabbable wherever it sits.
  return Math.abs(cy - yCeil(ceilDb)) <= Math.abs(cy - yFloor(floorDb)) ? `${id}CeilingDb` : `${id}FloorDb`;
}

/** Current y of a floor/ceiling line (0 offset for anything else). */
function compressorLineY(mode: string, p: CompressorFxSettings, h: number): number | null {
  const padY = 10;
  if (mode.endsWith('FloorDb')) return (h - padY) - dbToYNorm((p as any)[mode] ?? -55) * (h - 2 * padY);
  if (mode.endsWith('CeilingDb')) return (h - padY) - clamp01((((p as any)[mode] ?? -12) + 24) / 24) * (h - 2 * padY);
  return null;
}

/** Apply a pointer position to the dragged compressor target (absolute, not relative). */
function compressorApply(
  mode: string, cx: number, cy: number, w: number, h: number,
  p: CompressorFxSettings, onChange: (patch: Record<string, number>) => void,
) {
  const g = compressorGeom(p, w, h);
  if (mode === 'lowFreq') {
    onChange({ lowFreq: posToLow(clamp01((((cx - g.padX) / (w - 2 * g.padX)) - 0.15) / 0.3)) });
  } else if (mode === 'highFreq') {
    onChange({ highFreq: posToHigh(clamp01((((cx - g.padX) / (w - 2 * g.padX)) - 0.5) / 0.45)) });
  } else if (mode.endsWith('FloorDb')) {
    onChange({ [mode]: Math.max(COMP_FLOOR_RANGE[0], Math.min(COMP_FLOOR_RANGE[1], compYToDb(cy, h, g.padY))) });
  } else if (mode.endsWith('CeilingDb')) {
    onChange({ [mode]: Math.max(COMP_CEIL_RANGE[0], Math.min(COMP_CEIL_RANGE[1], -24 + 24 * yToNorm(cy, h, g.padY))) });
  } else if (mode.endsWith('Amount')) {
    onChange({ [mode]: yToNorm(cy, h, g.padY) });
  }
}

export function FxViz({ kind, params, onChange, level, trigger }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const pRef = useRef(params); pRef.current = params;
  const fallbackLvl = useRef(level); fallbackLvl.current = level;
  const smoothLvl = useRef(0);
  const ringsRef = useRef<Ring[]>([]);
  const lastTrigger = useRef(trigger);

  const toneYRef = useRef<number>(0.65);
  const widthYRef = useRef<number>(0.5);
  const fbYRef = useRef<number>(0.5);
  const stagesYRef = useRef<number>(0.5);

  const dragNodeRef = useRef<string | null>(null);
  const hoverNodeRef = useRef<string | null>(null);

  const drag = useRef<{ mode: 'size' | 'decay' | 'time' | 'drive' | 'depth' | 'ratio'; startY: number; base: number } | null>(null);

  // Spawn a burst when `trigger` changes.
  useEffect(() => {
    if (trigger === lastTrigger.current) return;
    lastTrigger.current = trigger;
    const p = pRef.current as ReverbFxSettings & DelayFxSettings & DistortionFxSettings & ChorusFxSettings & FlangerFxSettings & CompressorFxSettings & PhaserFxSettings;
    const now = performance.now() / 1000;
    const rings = ringsRef.current;
    if (kind === 'distortion' || kind === 'chorus' || kind === 'compressor') {
      rings.push({ born: now, amp: 1, ox: 0.5, oy: 0.5, idx: 0 });
    } else if (kind === 'reverb') {
      const count = 1 + Math.round((p.decay ?? 0.5) * 5);
      const gap = 0.07 + (p.decay ?? 0.5) * 0.14;
      for (let i = 0; i < count; i += 1) rings.push({ born: now + i * gap, amp: Math.pow(0.82, i), ox: 0.5, oy: 0.5, idx: i });
    } else {
      const fb = Math.max(0.02, p.feedback ?? 0.4);
      const gapMs = (p.timeMs ?? 300);
      const count = Math.min(16, Math.ceil(Math.log(0.05) / Math.log(fb)));
      for (let i = 0; i < count; i += 1) rings.push({ born: now + (i * gapMs) / 1000, amp: Math.pow(fb, i), ox: 0.5, oy: 0.5, idx: i });
    }
    if (rings.length > 80) rings.splice(0, rings.length - 80);
  }, [trigger, kind]);

  useEffect(() => {
    const cvs = ref.current;
    if (!cvs) return;
    const ctx = cvs.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let last = 0;
    const MIN_MS = 1000 / 30;

    const frame = (nowMs: number) => {
      raf = requestAnimationFrame(frame);
      if (nowMs - last < MIN_MS) return;
      last = nowMs;
      const t = nowMs / 1000;

      const rect = cvs.getBoundingClientRect();
      const w = rect.width;
      const h = rect.height;
      if (w < 2 || h < 2) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = Math.round(w * dpr);
      const Hh = Math.round(h * dpr);
      if (cvs.width !== W || cvs.height !== Hh) { cvs.width = W; cvs.height = Hh; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const p = pRef.current as ReverbFxSettings & DelayFxSettings & DistortionFxSettings & ChorusFxSettings & FlangerFxSettings & PhaserFxSettings;
      if (kind === 'flanger' || kind === 'phaser') {
        drawVitalResponse(ctx, w, h, kind, p, t, fallbackLvl.current);
        const nodes = getFxNodes(kind, p);
        const pal = kind === 'flanger' ? { h: 48, s: 90, l: 62 } : { h: 198, s: 85, l: 65 };
        drawNodeOverlayHandles(ctx, w, h, nodes, hoverNodeRef.current, dragNodeRef.current, pal);
        return;
      }

      if (kind === 'distortion') {
        drawDistortionGraphic(ctx, w, h, p as DistortionFxSettings, t);
        const nodes = getFxNodes('distortion', p);
        const pal = { h: 18, s: 95, l: 60 };
        drawNodeOverlayHandles(ctx, w, h, nodes, hoverNodeRef.current, dragNodeRef.current, pal);
        return;
      }

      if (kind === 'chorus') {
        drawChorusGraphic(ctx, w, h, p as ChorusFxSettings, t);
        const nodes = getFxNodes('chorus', p);
        const pal = { h: 280, s: 90, l: 65 };
        drawNodeOverlayHandles(ctx, w, h, nodes, hoverNodeRef.current, dragNodeRef.current, pal);
        return;
      }

      const rawLvl = getScopeRms('main');
            // SS160 (user: "the top visualizer doesnt seem to be so reactive at all
            // any more .. ive got it set to 6x and it barely even moves much even
            // when i put the volume of all oscs up to 100%").
            //
            // The bug was the SOURCE ARGUMENT, not the maths. `gainGroupFor` only
            // special-cases the literal string 'main' and maps everything else to the
            // 'op' group, so `getVizGain('fx')` was reading the **per-operator**
            // reactivity multiplier. But the 6x control lives on the main <Scope>
            // (Scope.tsx writes `setVizGain('main', p)` into the 'main' group), so the
            // setting the user was adjusting was never read by this visualizer at all
            // — the two were wired to different groups and no amount of dialling the
            // preset could affect it. The master RMS is read from the 'main' scope
            // frame two lines above, so 'main' is also the correct group; 'fx' was
            // never a source that exists in ScopeSource at all.
            const target = rawLvl > 1e-4 ? Math.min(1, rawLvl * 6 * getVizGain('main')) : fallbackLvl.current;
      smoothLvl.current += (target - smoothLvl.current) * 0.2;
      const lvl = Math.max(0, Math.min(1, smoothLvl.current));

      if (kind === 'compressor') {
        // `p` is typed as an intersection of the SIX non-compressor FX
        // settings (line 562) — it deliberately omits CompressorFxSettings, so
        // a direct cast has no overlapping members and TS rejects it (TS2352,
        // SS149 item 6). The intersection is itself a lie (the ref holds one
        // effect's params at a time); going through `unknown` states that
        // honestly rather than widening every property to `any`.
        drawMultibandCompressor(ctx, w, h, p as unknown as CompressorFxSettings, lvl, hoverNodeRef.current, dragNodeRef.current);
        return;
      }
      const damp = kind === 'reverb' ? (p.damp ?? 0.5) : kind === 'delay' ? (1 - (p.tone ?? 0.7)) : (1 - (p.tone ?? 0.7));
      const mix = p.mix ?? 0;
      const width = p.width ?? 0;
      const mod = p.mod ?? 0;
      const rate = p.rate ?? 0.5;
      const diff = p.diffusion ?? 0.3;
      // How "full" the effect is: decay for the reverb, feedback for the delay.
      const energy = kind === 'reverb' ? clamp01(p.decay ?? 0.5) : clamp01((p.feedback ?? 0.4) / 0.95);
      // Moving a node visibly re-colours the whole graphic: the cut/damp
      // handle sets the base hue (palette), stereo width rotates it, more
      // decay/feedback brightens it, diffusion saturates it, mix lifts the glow.
      const base = palette(damp);
      const pal = {
        h: base.h + (width - 0.5) * 40,
        s: Math.min(100, base.s * (0.7 + 0.3 * clamp01(diff + 0.25))),
        l: Math.min(90, base.l * (0.72 + 0.5 * energy)),
      };
      // Per-handle colour: hue follows where the handle sits, brightness its height.
      const nodePal = (n: FxNodeSpec) => ({
        h: pal.h + (n.nx - 0.5) * 60,
        s: pal.s,
        l: Math.min(92, pal.l * (0.85 + 0.35 * n.ny) + 6),
      });
      const omega = t * rate * Math.PI * 2;

      // chamber geometry
      // `kind` is exactly 'reverb' | 'delay' from here down: flanger/phaser
      // (563), distortion (571), chorus (579) and compressor (606) each draw
      // their own graphic and return. Any 'distortion'/'chorus' test below is
      // therefore unreachable — TS2367 flagged them (SS149 item 6) and they
      // are removed rather than silenced.
      const sizeT = kind === 'reverb' ? (0.28 + 0.5 * (p.size ?? 0.5)) : kind === 'delay' ? 0.44 : 0.4 + 0.2 * (p.depth ?? 0.45);
      const rx = w * 0.5 * sizeT * (1 - 0.18 * width);
      const ry = h * 0.5 * sizeT * (1 - 0.18 * width);
      const cx = w / 2;
      const cy = h / 2;
      const offX = width * w * 0.13;
      const centers = offX < 4 ? [cx] : [cx - offX, cx + offX];

      // background wash
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry) * 1.4);
      bg.addColorStop(0, `hsla(${pal.h},${pal.s}%,${pal.l}%,${0.05 + 0.1 * mix + 0.22 * energy * (0.35 + 0.65 * mix)})`);
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);

      // chamber boundary
      for (const ccx of centers) {
        ctx.beginPath();
        ctx.ellipse(ccx, cy, rx, ry, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `hsla(${pal.h},${pal.s}%,${Math.min(88, pal.l + 10)}%,${0.08 + 0.14 * energy + 0.06 * lvl})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      // reverb field dots
      if (kind === 'reverb') {
        const vis = 0.3 + diff * 0.7;
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 90; i += 1) {
          const seed = (i * 2654435761) % 1000 / 1000;
          if (seed > vis) continue;
          const ring = i % 8;
          const a = (i / 90) * Math.PI * 12 + ring;
          const rr = Math.pow((ring + 1) / 8, 1.3);
          const twinkle = 1 + mod * 0.5 * Math.sin(omega + i);
          const alpha = (0.05 + 0.12 * mix) * (1 - ring / 12) * (0.4 + 0.6 * lvl) * twinkle;
          if (alpha < 0.004) continue;
          const x = cx + Math.cos(a) * rr * rx;
          const y = cy + Math.sin(a) * rr * ry;
          ctx.fillStyle = `hsla(${pal.h + 10 * Math.sin(a)},${pal.s}%,${pal.l}%,${Math.min(0.8, alpha)})`;
          ctx.beginPath();
          ctx.arc(x, y, (1.1 + seed) * (0.9 + 0.4 * lvl), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
      }

      // rings
      const rings = ringsRef.current;
      const sweep = kind === 'reverb' ? 0.55 : kind === 'delay' ? 1.0 : kind === 'chorus' ? 0.9 : 0.75;
      const fade = kind === 'reverb' ? 0.4 + (p.decay ?? 0.5) * 2.6 : kind === 'delay' ? 0.5 + (1 - damp) * 1.4 : kind === 'chorus' ? 0.55 + (p.width ?? 0.65) * 0.7 : kind === 'distortion' ? 0.35 + (p.drive ?? 0.35) * 0.8 : 0.5;
      ctx.globalCompositeOperation = 'lighter';
      for (let i = rings.length - 1; i >= 0; i -= 1) {
        const rg = rings[i];
        const age = t - rg.born;
        if (age < 0) continue;
        const headR = Math.min(1, age / sweep);
        const a = rg.amp * 0.9 * Math.exp(-age / fade) * (kind === 'delay' ? 1 - 0.4 * headR : 1);
        if (a < 0.02 || age > sweep + fade * 1.8) { rings.splice(i, 1); continue; }
        for (const ccx of centers) {
          const lig = Math.min(96, pal.l + 16);
          // glow
          ctx.strokeStyle = `hsla(${pal.h},${pal.s}%,${lig}%,${a * 0.28})`;
          ctx.lineWidth = 5 + diff * 5;
          drawRing(ctx, ccx, cy, headR * rx, headR * ry, mod, omega, rg.idx);
          // crisp
          ctx.strokeStyle = `hsla(${pal.h},${pal.s}%,${lig}%,${a})`;
          ctx.lineWidth = 1.6;
          drawRing(ctx, ccx, cy, headR * rx, headR * ry, mod, omega, rg.idx);
        }
      }
      ctx.globalCompositeOperation = 'source-over';

      // source dot(s)
      const dry = Math.pow(1 - mix, 1.3) + 0.12;
      const sr = (3.5 + 9 * lvl) * (0.5 + 0.5 * dry) + 2;
      for (const ccx of centers) {
        ctx.globalCompositeOperation = 'lighter';
        const halo = ctx.createRadialGradient(ccx, cy, 0, ccx, cy, sr * 6);
        halo.addColorStop(0, `hsla(${pal.h},${pal.s}%,${Math.min(94, pal.l + 16)}%,${0.6 * dry})`);
        halo.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(ccx, cy, sr * 6, 0, Math.PI * 2); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = `hsla(${pal.h},${Math.max(20, pal.s - 20)}%,${Math.min(98, pal.l + 20)}%,${0.7 + 0.3 * dry})`;
        ctx.beginPath(); ctx.arc(ccx, cy, sr, 0, Math.PI * 2); ctx.fill();
      }

      if (kind === 'delay' || kind === 'reverb') {
        drawNodeOverlayHandles(ctx, w, h, getFxNodes(kind, p), hoverNodeRef.current, dragNodeRef.current, nodePal);
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [kind]);

  // Pointer event logic for interactive nodes and legacy dragging
  const updateNodeFromPointer = (nodeId: string, clientX: number, clientY: number, rect: DOMRect) => {
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    const nx = Math.max(0, Math.min(1, (cx - PAD_X) / (rect.width - 2 * PAD_X)));
    const ny = Math.max(0, Math.min(1, ((rect.height - PAD_Y) - cy) / (rect.height - 2 * PAD_Y)));

    if (kind === 'distortion') {
      if (nodeId === 'drive') {
        onChange({ drive: nx });
      } else if (nodeId === 'tone') {
        onChange({ tone: nx });
      }
    } else if (kind === 'chorus') {
      if (nodeId === 'width') {
        const wVal = Math.abs(nx - 0.5) >= Math.abs(ny - 0.5) ? nx : ny;
        onChange({ width: Math.max(0, Math.min(1, wVal)) });
      } else if (nodeId === 'rate-depth') {
        onChange({ rate: posToRate(nx), depth: ny });
      }
    } else if (kind === 'flanger') {
      if (nodeId === 'rate-depth') {
        onChange({ rate: posToRate(nx), depth: ny });
      } else if (nodeId === 'feedback') {
        onChange({ feedback: nx * 0.9 });
      }
    } else if (kind === 'phaser') {
      if (nodeId === 'rate-depth') {
        onChange({ rate: posToRate(nx), depth: ny });
      } else if (nodeId === 'stages-fb') {
        const stages = Math.round(2 + nx * 6);
        onChange({ stages, feedback: ny * 0.9 });
      }
    } else if (kind === 'delay') {
      if (nodeId === 'time-fb') onChange({ timeMs: posToTime(nx), feedback: ny * 0.95 });
      else if (nodeId === 'rate-mod') onChange({ rate: posToRate(nx), mod: ny });
      else if (nodeId === 'width-diff') onChange({ width: nx, diffusion: ny });
      else if (nodeId === 'cut') onChange({ locut: nx, tone: ny });
    } else if (kind === 'reverb') {
      if (nodeId === 'size-decay') onChange({ size: nx, decay: ny });
      else if (nodeId === 'rate-mod') onChange({ rate: posToRate(nx), mod: ny });
      else if (nodeId === 'width-diff') onChange({ width: nx, diffusion: ny });
      else if (nodeId === 'cut') onChange({ locut: nx, damp: ny });
    }
  };

  /** Vital-style response-curve drag (flanger / phaser) — the whole canvas
   *  is the pad: X = rate (log), Y = depth; Shift = feedback (X); Alt =
   *  stages (phaser) or mix (Y) / width (X) (flanger). */
  const applyResponseDrag = (clientX: number, clientY: number, rect: DOMRect, shift: boolean, alt: boolean) => {
    const nx = Math.max(0, Math.min(1, (clientX - rect.left - PAD_X) / (rect.width - 2 * PAD_X)));
    const ny = Math.max(0, Math.min(1, ((rect.height - PAD_Y) - (clientY - rect.top)) / (rect.height - 2 * PAD_Y)));
    if (kind === 'flanger') {
      if (shift) onChange({ feedback: nx * 0.9 });
      else if (alt) onChange({ mix: ny, width: nx });
      else onChange({ rate: posToRate(nx), depth: ny });
    } else if (shift) {
      onChange({ feedback: nx * 0.9 });
    } else if (alt) {
      onChange({ stages: Math.round(2 + nx * 6), depth: ny });
    } else {
      onChange({ rate: posToRate(nx), depth: ny });
    }
  };

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return; // right/middle clicks never start (or capture) a drag
    e.preventDefault(); // POLICY: no text selection starts during a drag (see ui-selection test)
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();

    if (isNodeKind(kind)) {
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const p = pRef.current;
      const nodes = getFxNodes(kind, p);

      let closestNode: FxNodeSpec | null = null;
      let minDist = Infinity;
      for (const node of nodes) {
        const ncx = PAD_X + node.nx * (rect.width - 2 * PAD_X);
        const ncy = (rect.height - PAD_Y) - node.ny * (rect.height - 2 * PAD_Y);
        const dist = Math.hypot(cx - ncx, cy - ncy);
        if (dist < minDist) {
          minDist = dist;
          closestNode = node;
        }
      }

      if (closestNode && minDist <= 40) {
        dragNodeRef.current = closestNode.id;
        updateNodeFromPointer(closestNode.id, e.clientX, e.clientY, rect);
        return;
      }

      if (kind === 'flanger' || kind === 'phaser') {
        applyResponseDrag(e.clientX, e.clientY, rect, e.shiftKey, e.altKey);
        const cvs = ref.current;
        if (cvs) cvs.style.cursor = 'grabbing';
        return;
      }

      if (closestNode) {
        dragNodeRef.current = closestNode.id;
        updateNodeFromPointer(closestNode.id, e.clientX, e.clientY, rect);
      }
      return;
    }

    // Legacy controls for other effects
    const p = pRef.current as ReverbFxSettings & DelayFxSettings & DistortionFxSettings & ChorusFxSettings & FlangerFxSettings & CompressorFxSettings & PhaserFxSettings;
    if (kind === 'compressor') {
      // Left button only — a right-click used to start a drag whose pointer-up
      // the context menu swallowed, leaving it "stuck" so the value then
      // followed a button-less mouse (the "works after a right-click" glitch).
      if (e.button !== 0) return;
      const t = compressorTargetAt(pRef.current as CompressorFxSettings, e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      if (t) {
        // Keep the grab offset so the line doesn't jump to the cursor on press.
        const ly = compressorLineY(t, pRef.current as CompressorFxSettings, rect.height);
        drag.current = { mode: t as any, startY: e.clientX, base: ly == null ? 0 : ly - (e.clientY - rect.top) };
      }
      return;
    }
    const nx = (e.clientX - rect.left - rect.width / 2) / (rect.width / 2);
    const ny = (e.clientY - rect.top - rect.height / 2) / (rect.height / 2);
    const dist = Math.hypot(nx, ny);
    drag.current = Math.abs(dist - (0.28 + 0.5 * (p.size ?? 0.5))) < 0.18
      ? { mode: 'size', startY: e.clientY, base: p.size ?? 0.5 }
      : { mode: 'decay', startY: e.clientY, base: p.decay ?? 0.5 };
  };

  const onMove = (e: React.PointerEvent) => {
    const cvs = ref.current;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();

    if (isNodeKind(kind)) {
      if (dragNodeRef.current) {
        updateNodeFromPointer(dragNodeRef.current, e.clientX, e.clientY, rect);
        if (cvs) cvs.style.cursor = 'grabbing';
      } else {
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const p = pRef.current;
        const nodes = getFxNodes(kind, p);

        let hovered: string | null = null;
        for (const node of nodes) {
          const ncx = PAD_X + node.nx * (rect.width - 2 * PAD_X);
          const ncy = (rect.height - PAD_Y) - node.ny * (rect.height - 2 * PAD_Y);
          if (Math.hypot(cx - ncx, cy - ncy) <= 25) {
            hovered = node.id;
            break;
          }
        }
        hoverNodeRef.current = hovered;
        if (cvs) cvs.style.cursor = hovered ? 'grab' : 'crosshair';
      }
      return;
    }

    if (kind === 'compressor') {
      const pc = pRef.current as CompressorFxSettings;
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const d = drag.current;
      if (!d || e.buttons === 0) {
        if (d) drag.current = null; // button released outside the canvas: never stay "stuck"
        dragNodeRef.current = null;
        const hT = compressorTargetAt(pc, cx, cy, rect.width, rect.height);
        hoverNodeRef.current = hT;
        if (cvs) cvs.style.cursor = hT ? 'grab' : 'default';
        return;
      }
      dragNodeRef.current = d.mode as string;
      if (cvs) cvs.style.cursor = 'grabbing';
      compressorApply(d.mode as string, cx, cy + d.base, rect.width, rect.height, pc, onChange);
      return;
    }

    const d = drag.current;
    if (!d) return;
    const dy = (d.startY - e.clientY);
    if (d.mode === 'time') onChange({ timeMs: Math.max(1, Math.min(2000, d.base + dy * 4)) });
    else if (d.mode === 'depth') onChange({ depth: Math.max(-1, Math.min(1, d.base + dy / 220)) });
    else if (d.mode === 'ratio') onChange({ ratio: Math.max(0, Math.min(1, d.base + dy / 220)) });
    else onChange({ [d.mode]: Math.max(0, Math.min(1, d.base + dy / 220)) });
  };

  const onUp = (e: React.PointerEvent) => {
    dragNodeRef.current = null;
    drag.current = null;
    const cvs = ref.current;
    if (!cvs) return;
    if (kind === 'flanger' || kind === 'phaser') cvs.style.cursor = 'crosshair';
    else if (isNodeKind(kind)) cvs.style.cursor = hoverNodeRef.current ? 'grab' : 'crosshair';
  };

  return (
    <canvas
      ref={ref}
      className="fx-viz-canvas"
      data-allow-2d=""
      style={{ cursor: isNodeKind(kind) ? 'crosshair' : undefined }}
      title={
        kind === 'flanger'
          ? 'Vital-style flanger response: drag = rate/depth · Shift-drag = feedback · Alt-drag = mix/width'
          : kind === 'phaser'
          ? 'Vital-style phaser response: drag = rate/depth · Shift-drag = feedback · Alt-drag = stages'
          : kind === 'distortion'
          ? 'Drag node handles: Bottom-Left = 0% Mix (Bypass) · Top-Right = 100% Mix · Drag Tone to adjust'
          : kind === 'chorus'
          ? 'Drag node handles: Bottom-Left = 0% Mix (Bypass) · Top-Right = 100% Mix · Drag Rate/Depth'
          : kind === 'delay'
          ? 'Drag node handles: Time/Feedback · Rate/Mod · Width/Diffusion · LoCut/HiCut (Mix is the header slider)'
          : kind === 'reverb'
          ? 'Drag node handles: Size/Decay · Rate/Mod · Width/Diffusion · LoCut/Damp (Mix is the header slider)'
          : 'Drag ↕ — compression ratio'
      }
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    />
  );
}

function drawRing(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, rx: number, ry: number,
  mod: number, omega: number, idx: number,
) {
  ctx.beginPath();
  const pts = 84;
  for (let k = 0; k <= pts; k += 1) {
    const a = (k / pts) * Math.PI * 2;
    const wob = 1 + mod * 0.13 * Math.sin(omega + a * 3 + idx * 0.4);
    const x = cx + Math.cos(a) * rx * wob;
    const y = cy + Math.sin(a) * ry * wob;
    if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

// -------------------------------------------------------------------------
// Vital-style frequency-response canvas (flanger + phaser). The drawn curve
// is the effect's REAL magnitude response: flanger = feedback comb of a
// modulated delay line, phaser = a stack of 1st-order all-passes — notches
// (glowing dots) ride the LFO sweep exactly like the audio does. Drag any-
// where = rate (X, log) / depth (Y); Shift = feedback (X); Alt = stages
// (phaser) or mix/width (flanger).
const RESP_F_MIN = 20;
const RESP_F_MAX = 20000;

/** Vital-style animated frequency-response curve (flanger + phaser). */
function drawVitalResponse(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  kind: 'flanger' | 'phaser',
  p: FlangerFxSettings & PhaserFxSettings,
  t: number,
  level: number,
) {
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.5));
  const depth = Math.max(0, Math.min(1, p.depth ?? 0.5));
  const fb = Math.max(0, Math.min(0.9, p.feedback ?? 0.4));
  const stages = kind === 'phaser' ? Math.round(p.stages ?? 4) : 0;
  const sweep = Math.sin(t * rate * Math.PI * 2); // -1..1 LFO sweep

  const fToX = (f: number) =>
    PAD_X + (Math.log(Math.max(RESP_F_MIN, Math.min(RESP_F_MAX, f)) / RESP_F_MIN) / Math.log(RESP_F_MAX / RESP_F_MIN)) * (w - 2 * PAD_X);

  if (kind === 'flanger') {
    // -----------------------------------------------------------------------
    // FLANGER: Golden comb-filter peaks pointing UPWARDS (Image 2)
    // -----------------------------------------------------------------------
    ctx.fillStyle = '#07040d';
    ctx.fillRect(0, 0, w, h);

    // Subtle dark purple background wash
    const bgGrad = ctx.createLinearGradient(0, h, 0, 0);
    bgGrad.addColorStop(0, 'rgba(67, 24, 105, 0.45)');
    bgGrad.addColorStop(1, 'rgba(7, 4, 13, 0.0)');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, w, h);

    // Freq grid lines
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
    ctx.lineWidth = 1;
    ctx.font = '7px monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      const x = fToX(f);
      ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 4); ctx.stroke();
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 5);
    }

    // Delay time in seconds, modulated by depth & LFO sweep
    const baseDel = 0.001 + 0.004 * (1 - depth * 0.5); // ~1ms to ~5ms
    const del = baseDel * (1 + 0.3 * depth * sweep);
    const pts = 300; // high point density for fine comb teeth

    ctx.beginPath();
    for (let i = 0; i <= pts; i += 1) {
      const frac = i / pts;
      const f = RESP_F_MIN * Math.pow(RESP_F_MAX / RESP_F_MIN, frac);
      const x = fToX(f);

      // Comb magnitude: peaks at integers of (f * del)
      const phase = 2 * Math.PI * f * del;
      const comb = Math.pow(Math.abs(Math.cos(phase)), 1.5 + fb * 3);
      const yNorm = 0.15 + 0.7 * comb;
      const y = (h - PAD_Y) - yNorm * (h - 2 * PAD_Y);

      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }

    // Golden stroke line
    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 1.8;
    ctx.shadowColor = '#f59e0b';
    ctx.shadowBlur = 6;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Fill underneath curve down to bottom
    ctx.lineTo(w - PAD_X, h - PAD_Y);
    ctx.lineTo(PAD_X, h - PAD_Y);
    ctx.closePath();

    const fillGrad = ctx.createLinearGradient(0, PAD_Y, 0, h - PAD_Y);
    fillGrad.addColorStop(0, 'rgba(168, 85, 247, 0.4)');
    fillGrad.addColorStop(1, 'rgba(88, 28, 135, 0.05)');
    ctx.fillStyle = fillGrad;
    ctx.fill();

    // Overlay readouts
    ctx.font = '8px monospace';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.fillText(`RATE ${rate.toFixed(2)}Hz`, PAD_X + 4, 13);
    ctx.fillText(`DEPTH ${Math.round(depth * 100)}%`, PAD_X + 4, 24);
    ctx.fillText(`FB ${Math.round(fb * 100)}%`, w - PAD_X - 52, 13);
    return;
  }

  // -------------------------------------------------------------------------
  // PHASER: Bright cyan wave curve (Image 3)
  // -------------------------------------------------------------------------
  ctx.fillStyle = '#030914';
  ctx.fillRect(0, 0, w, h);

  // Subtle dark cyan background wash
  const bgGrad = ctx.createLinearGradient(0, h, 0, 0);
  bgGrad.addColorStop(0, 'rgba(14, 116, 144, 0.35)');
  bgGrad.addColorStop(1, 'rgba(3, 9, 20, 0.0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // Freq grid lines
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.font = '7px monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = fToX(f);
    ctx.beginPath(); ctx.moveTo(x, 4); ctx.lineTo(x, h - 4); ctx.stroke();
    ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 2, h - 5);
  }

  const numStages = Math.max(2, stages || 4);
  const pts = 160;
  ctx.beginPath();

  for (let i = 0; i <= pts; i += 1) {
    const frac = i / pts;
    const f = RESP_F_MIN * Math.pow(RESP_F_MAX / RESP_F_MIN, frac);
    const x = fToX(f);

    // Multi-stage allpass phase response wave shape
    const phaseArg = (numStages / 2) * Math.PI * (frac - 0.5 * (1 + sweep * depth * 0.6));
    const wave = Math.sin(phaseArg);
    const yNorm = 0.3 + 0.55 * (0.5 + 0.5 * wave);
    const y = (h - PAD_Y) - yNorm * (h - 2 * PAD_Y);

    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }

  // Cyan stroke line
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2.0;
  ctx.shadowColor = '#0ea5e9';
  ctx.shadowBlur = 8;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Fill underneath curve down to bottom
  ctx.lineTo(w - PAD_X, h - PAD_Y);
  ctx.lineTo(PAD_X, h - PAD_Y);
  ctx.closePath();

  const fillGrad = ctx.createLinearGradient(0, PAD_Y, 0, h - PAD_Y);
  fillGrad.addColorStop(0, 'rgba(14, 165, 233, 0.35)');
  fillGrad.addColorStop(1, 'rgba(3, 105, 161, 0.04)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Overlay readouts
  ctx.font = '8px monospace';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
  ctx.fillText(`RATE ${rate.toFixed(2)}Hz`, PAD_X + 4, 13);
  ctx.fillText(`DEPTH ${Math.round(depth * 100)}%`, PAD_X + 4, 24);
  ctx.fillText(`STAGES ${numStages}`, w - PAD_X - 60, 13);
  ctx.fillText(`FB ${Math.round(fb * 100)}%`, w - PAD_X - 60, 24);
}

/** Distortion graphical UI: Anger/Heat saturation curve (white -> yellow -> orange -> red). */
function drawDistortionGraphic(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  p: DistortionFxSettings,
  t: number,
) {
  const drive = Math.max(0, Math.min(1, p.drive ?? 0.35));
  const tone = Math.max(0, Math.min(1, p.tone ?? 0.7));

  // Color progression: White (clean) -> Yellow -> Orange -> Red (overdrive/anger)
  let mainColor = '#ffffff';
  let glowColor = 'rgba(255, 255, 255, 0.4)';
  let bgGlow = 'rgba(255, 255, 255, 0.05)';

  if (drive < 0.25) {
    const u = drive / 0.25;
    mainColor = u < 0.5 ? '#ffffff' : '#fef08a';
    glowColor = `rgba(254, 240, 138, ${0.3 + 0.3 * u})`;
    bgGlow = `rgba(254, 240, 138, ${0.03 + 0.05 * u})`;
  } else if (drive < 0.6) {
    const u = (drive - 0.25) / 0.35;
    mainColor = u < 0.5 ? '#facc15' : '#f97316';
    glowColor = `rgba(249, 115, 22, ${0.4 + 0.3 * u})`;
    bgGlow = `rgba(249, 115, 22, ${0.08 + 0.08 * u})`;
  } else {
    const u = (drive - 0.6) / 0.4;
    mainColor = u > 0.5 ? '#ef4444' : '#dc2626';
    glowColor = `rgba(239, 68, 68, ${0.6 + 0.4 * u})`;
    bgGlow = `rgba(239, 68, 68, ${0.15 + 0.25 * u})`;
  }

  // Background
  ctx.fillStyle = '#070405';
  ctx.fillRect(0, 0, w, h);

  // Radial heat wash in center
  const cx = w / 2;
  const cy = h / 2;
  const heatRad = Math.max(w, h) * (0.3 + 0.45 * drive);
  const heat = ctx.createRadialGradient(cx, cy, 0, cx, cy, heatRad);
  heat.addColorStop(0, bgGlow);
  heat.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = heat;
  ctx.fillRect(0, 0, w, h);

  // Saturation / Overdrive Waveform
  const pts = 160;
  const kDrive = 1 + 14 * drive;
  const toneFilter = 0.5 + 1.5 * tone;

  ctx.beginPath();
  for (let i = 0; i <= pts; i += 1) {
    const frac = i / pts;
    const x = PAD_X + frac * (w - 2 * PAD_X);
    const phase = (frac * Math.PI * 4 * toneFilter) + t * 4;

    const rawSine = Math.sin(phase);
    const clipped = Math.tanh(rawSine * kDrive);
    const yNorm = 0.5 - 0.38 * clipped;
    const y = PAD_Y + yNorm * (h - 2 * PAD_Y);

    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }

  ctx.strokeStyle = mainColor;
  ctx.lineWidth = 2.0 + drive * 1.5;
  ctx.shadowColor = glowColor;
  ctx.shadowBlur = 6 + drive * 14;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Fill under waveform
  ctx.lineTo(w - PAD_X, h - PAD_Y);
  ctx.lineTo(PAD_X, h - PAD_Y);
  ctx.closePath();
  const fillGrad = ctx.createLinearGradient(0, PAD_Y, 0, h - PAD_Y);
  fillGrad.addColorStop(0, glowColor);
  fillGrad.addColorStop(1, 'rgba(0, 0, 0, 0.02)');
  ctx.fillStyle = fillGrad;
  ctx.fill();

  // Sparks/embers at high drive
  if (drive > 0.5) {
    const sparkCount = Math.round((drive - 0.5) * 14);
    ctx.fillStyle = mainColor;
    for (let s = 0; s < sparkCount; s += 1) {
      const sx = PAD_X + Math.random() * (w - 2 * PAD_X);
      const sy = cy + (Math.random() - 0.5) * (h * 0.7);
      ctx.fillRect(sx, sy, 2, 2);
    }
  }
}

/** Chorus graphical UI: Multi-voice detuned spatial waves (Magenta / Violet / Cyan). */
function drawChorusGraphic(
  ctx: CanvasRenderingContext2D,
  w: number, h: number,
  p: ChorusFxSettings,
  t: number,
) {
  const rate = Math.max(0.05, Math.min(5, p.rate ?? 0.8));
  const depth = Math.max(0, Math.min(1, p.depth ?? 0.45));
  const width = Math.max(0, Math.min(1, p.width ?? 0.65));

  ctx.fillStyle = '#06040e';
  ctx.fillRect(0, 0, w, h);

  const bgGrad = ctx.createLinearGradient(0, h, 0, 0);
  bgGrad.addColorStop(0, 'rgba(168, 85, 247, 0.25)');
  bgGrad.addColorStop(1, 'rgba(6, 4, 14, 0)');
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  const voices = [
    { color: '#ec4899', fill: 'rgba(236,72,153,0.08)', phaseOff: 0, freqMult: 1.0 },
    { color: '#a855f7', fill: 'rgba(168,85,247,0.08)', phaseOff: Math.PI * 0.6, freqMult: 1.25 },
    { color: '#06b6d4', fill: 'rgba(6,182,212,0.08)', phaseOff: Math.PI * 1.3, freqMult: 0.85 },
  ];

  const pts = 120;
  for (const v of voices) {
    ctx.beginPath();
    for (let i = 0; i <= pts; i += 1) {
      const frac = i / pts;
      const x = PAD_X + frac * (w - 2 * PAD_X);
      const phase = (frac * Math.PI * 3 * v.freqMult) + (t * rate * Math.PI * 2) + v.phaseOff;
      const wave = Math.sin(phase) * (0.15 + 0.35 * depth);
      const y = (h / 2) + wave * (h * 0.4);

      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }

    ctx.strokeStyle = v.color;
    ctx.lineWidth = 1.8;
    ctx.stroke();

    ctx.lineTo(w - PAD_X, h - PAD_Y);
    ctx.lineTo(PAD_X, h - PAD_Y);
    ctx.closePath();
    ctx.fillStyle = v.fill;
    ctx.fill();
  }

  if (width > 0.1) {
    const arcR = 8 + width * 18;
    ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)';
    ctx.lineWidth = 1.5;

    ctx.beginPath(); ctx.arc(PAD_X + 6, h / 2, arcR, -Math.PI * 0.4, Math.PI * 0.4); ctx.stroke();
    ctx.beginPath(); ctx.arc(w - PAD_X - 6, h / 2, arcR, Math.PI * 0.6, Math.PI * 1.4); ctx.stroke();
  }
}
