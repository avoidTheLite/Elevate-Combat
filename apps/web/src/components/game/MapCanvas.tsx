import { useRef, useEffect, useState } from 'react';
import type { HeightMap, UnitInstance, Team } from '@iron-ridge/types';
import { Button } from '../ui/Button.tsx';

// ── Projection constants ─────────────────────────────────────────────────────
const TW = 20,
  TH = 10,
  HS = 13;
const CW = 800,
  CH = 490;
const OX = 240,
  OY = 125;

// Height → color palette (index = height 0..8)
const PAL = [
  '#000c18',
  '#001e30',
  '#003450',
  '#00516e',
  '#00718e',
  '#0094b0',
  '#18b8d4',
  '#48d8f8',
  '#ffb820',
];

const proj = (c: number, r: number, h: number): { x: number; y: number } => ({
  x: OX + (c - r) * TW,
  y: OY + (c + r) * TH - h * HS,
});

const safeH = (hm: HeightMap, c: number, r: number): number => {
  const rows = hm.length,
    cols = hm[0]?.length ?? 0;
  return r >= 0 && r < rows && c >= 0 && c < cols ? (hm[r]![c] ?? 0) : 0;
};

const pal = (h: number): string => PAL[Math.max(0, Math.min(8, Math.round(h)))]!;

const rgba = (hex: string, a: number): string => {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};

interface Props {
  hm: HeightMap;
  units: UnitInstance[];
  selectedId: string | null;
  activeTeam: Team;
  onUnitClick: (id: string) => void;
}

export function MapCanvas({ hm, units, selectedId, activeTeam, onUnitClick }: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<'iso' | 'data'>('iso');

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const COLS = hm[0]?.length ?? 0;
    const ROWS = hm.length;

    ctx.fillStyle = '#000810';
    ctx.fillRect(0, 0, CW, CH);
    for (let y = 0; y < CH; y += 4) {
      ctx.fillStyle = 'rgba(0,170,255,0.018)';
      ctx.fillRect(0, y, CW, 1);
    }

    if (view === 'iso') drawISO(ctx, COLS, ROWS);
    else drawData(ctx, COLS, ROWS);
  }, [view, hm, units, selectedId, activeTeam]);

  function drawISO(ctx: CanvasRenderingContext2D, COLS: number, ROWS: number): void {
    ctx.fillStyle = '#00ddff';
    ctx.font = 'bold 11px "Courier New",monospace';
    ctx.textAlign = 'left';
    ctx.fillText('// IRON RIDGE :: TRAINING SIMULATION :: MAP-01 "THE DEFILE"', 14, 20);
    ctx.fillStyle = '#004455';
    ctx.font = '9px "Courier New",monospace';
    ctx.fillText(
      `GEOMETRY ENGINE ACTIVE  |  GRID ${COLS}×${ROWS}  |  H_RANGE 0–8  |  ACTIVE: TEAM ${activeTeam}`,
      14,
      35,
    );

    for (let sum = 0; sum <= COLS + ROWS - 2; sum++) {
      for (let c = Math.max(0, sum - ROWS + 1); c <= Math.min(COLS - 1, sum); c++) {
        const r = sum - c;
        const h = hm[r]?.[c] ?? 0;
        const clr = pal(h);
        const p0 = proj(c, r, h),
          p1 = proj(c + 1, r, h);
        const p2 = proj(c + 1, r + 1, h),
          p3 = proj(c, r + 1, h);

        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fillStyle = rgba(clr, h === 8 ? 0.3 : 0.13);
        ctx.fill();
        ctx.strokeStyle = rgba(clr, h >= 7 ? 0.9 : h >= 5 ? 0.65 : 0.48);
        ctx.lineWidth = h === 8 ? 1.1 : 0.65;
        ctx.stroke();

        const hs = safeH(hm, c, r + 1);
        if (h > hs) {
          const s0 = proj(c, r + 1, h),
            s1 = proj(c + 1, r + 1, h);
          const s2 = proj(c + 1, r + 1, hs),
            s3 = proj(c, r + 1, hs);
          ctx.beginPath();
          ctx.moveTo(s0.x, s0.y);
          ctx.lineTo(s1.x, s1.y);
          ctx.lineTo(s2.x, s2.y);
          ctx.lineTo(s3.x, s3.y);
          ctx.closePath();
          ctx.fillStyle = rgba(clr, 0.07);
          ctx.fill();
          ctx.strokeStyle = rgba(clr, 0.38);
          ctx.lineWidth = 0.38;
          ctx.stroke();
        }

        const he = safeH(hm, c + 1, r);
        if (h > he) {
          const e0 = proj(c + 1, r, h),
            e1 = proj(c + 1, r + 1, h);
          const e2 = proj(c + 1, r + 1, he),
            e3 = proj(c + 1, r, he);
          ctx.beginPath();
          ctx.moveTo(e0.x, e0.y);
          ctx.lineTo(e1.x, e1.y);
          ctx.lineTo(e2.x, e2.y);
          ctx.lineTo(e3.x, e3.y);
          ctx.closePath();
          ctx.fillStyle = rgba(clr, 0.04);
          ctx.fill();
          ctx.strokeStyle = rgba(clr, 0.38);
          ctx.lineWidth = 0.38;
          ctx.stroke();
        }
      }
    }

    const ann = (c: number, r: number, lines: string[], clr: string, dy = 0): void => {
      const h = safeH(hm, Math.floor(c), Math.floor(r));
      const p = proj(c + 0.5, r + 0.5, h);
      ctx.font = 'bold 7.5px "Courier New",monospace';
      ctx.textAlign = 'center';
      lines.forEach((ln, i) => {
        ctx.strokeStyle = '#000810';
        ctx.lineWidth = 3;
        ctx.strokeText(ln, p.x, p.y + dy + i * 10);
        ctx.fillStyle = clr;
        ctx.fillText(ln, p.x, p.y + dy + i * 10);
      });
    };
    ann(9.5, 5, ['▲ RIDGE', 'H:8'], '#ffaa00', -20);
    ann(5.5, 5, ['W.DEFILE', 'H:2'], '#88cc00', -4);
    ann(13.5, 5, ['E.DEFILE', 'H:2'], '#88cc00', -4);
    ann(2.0, 3, ['◈ ALPHA BASE'], '#00ddff', -14);
    ann(16.5, 3, ['◈ BRAVO BASE'], '#ff4466', -14);

    units.forEach((u) => {
      const h = safeH(hm, u.col, u.row);
      const p = proj(u.col + 0.5, u.row + 0.5, h);
      const isSelected = u.id === selectedId;
      const clr = u.team === 'A' ? '#00ffff' : '#ff3355';
      const unitClr = u.hp <= 0 ? '#333344' : clr;

      if (isSelected) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 16, 0, Math.PI * 2);
        ctx.strokeStyle = '#ffff00';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      if (u.hp > 0) {
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 12);
        g.addColorStop(0, rgba(unitClr, 0.55));
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.fillStyle = unitClr;
      const def = u.defId;
      if (def.includes('tank') || def.includes('at_gun')) {
        ctx.fillRect(p.x - 4, p.y - 4, 8, 8);
      } else if (def.includes('artillery') || def.includes('mortar') || def.includes('catapult')) {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 6);
        ctx.lineTo(p.x + 5, p.y + 4);
        ctx.lineTo(p.x - 5, p.y + 4);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(p.x, p.y - 5);
        ctx.lineTo(p.x + 4, p.y);
        ctx.lineTo(p.x, p.y + 5);
        ctx.lineTo(p.x - 4, p.y);
        ctx.closePath();
        ctx.fill();
      }

      if (u.hp > 0) {
        const bw = 20,
          bh = 3;
        const bx = p.x - bw / 2,
          by = p.y + 8;
        ctx.fillStyle = '#111';
        ctx.fillRect(bx, by, bw, bh);
        ctx.fillStyle = u.hp / u.maxHp > 0.5 ? '#00ff66' : '#ffaa00';
        ctx.fillRect(bx, by, (u.hp / u.maxHp) * bw, bh);
      }

      ctx.font = 'bold 7px "Courier New",monospace';
      ctx.textAlign = 'center';
      ctx.strokeStyle = '#000810';
      ctx.lineWidth = 2.5;
      ctx.strokeText(u.label, p.x, p.y - 9);
      ctx.fillStyle = unitClr;
      ctx.fillText(u.label, p.x, p.y - 9);
    });
  }

  function drawData(ctx: CanvasRenderingContext2D, COLS: number, ROWS: number): void {
    ctx.fillStyle = '#00ddff';
    ctx.font = 'bold 11px "Courier New",monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`// HEIGHT MAP :: MAP-01 "THE DEFILE"  ::  COLS=${COLS}  ROWS=${ROWS}  H_MAX=8`, 14, 20);

    const CELL = 29,
      SX = 42,
      SY = 52;

    for (let c = 0; c < COLS; c++) {
      ctx.fillStyle = '#003344';
      ctx.font = '7px monospace';
      ctx.textAlign = 'center';
      ctx.fillText(String(c), SX + c * CELL + CELL / 2, SY - 6);
    }

    for (let r = 0; r < ROWS; r++) {
      ctx.fillStyle = '#003344';
      ctx.font = '7px monospace';
      ctx.textAlign = 'right';
      ctx.fillText(String(r), SX - 6, SY + r * CELL + CELL / 2 + 3);

      for (let c = 0; c < COLS; c++) {
        const h = hm[r]?.[c] ?? 0;
        const clr = pal(h);
        const x = SX + c * CELL,
          y = SY + r * CELL;
        const unit = units.find((u) => u.col === c && u.row === r);

        ctx.fillStyle = rgba(clr, 0.18);
        ctx.fillRect(x, y, CELL - 1, CELL - 1);
        ctx.strokeStyle = rgba(clr, unit ? 1.0 : 0.42);
        ctx.lineWidth = unit ? 1.8 : 0.55;
        ctx.strokeRect(x, y, CELL - 1, CELL - 1);

        ctx.fillStyle = clr;
        ctx.font = `${h === 8 ? 'bold ' : ''}${h >= 7 ? 12 : 10}px "Courier New",monospace`;
        ctx.textAlign = 'center';
        ctx.fillText(String(h), x + CELL / 2, y + CELL / 2 + 4);

        if (unit) {
          const uc = unit.team === 'A' ? '#00ffff' : '#ff3355';
          ctx.fillStyle = uc;
          ctx.beginPath();
          ctx.arc(x + CELL - 5, y + 5, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  return (
    <div className="flex flex-col items-center">
      <div className="flex gap-2 mb-2 w-full max-w-[800px]">
        <Button variant={view === 'iso' ? 'default' : 'ghost'} onClick={() => setView('iso')}>
          [ ISOMETRIC VIEW ]
        </Button>
        <Button variant={view === 'data' ? 'default' : 'ghost'} onClick={() => setView('data')}>
          [ DATA GRID ]
        </Button>
        <span className="text-[hsl(var(--border))] text-[8px] leading-7 ml-2">
          {view === 'iso' ? 'RENDERED TOPOLOGY' : 'RAW HEIGHT VALUES'}
        </span>
      </div>
      <canvas
        ref={canvasRef}
        width={CW}
        height={CH}
        style={{ display: 'block', maxWidth: '100%', border: '1px solid hsl(var(--border))', cursor: 'pointer' }}
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const scaleX = CW / rect.width;
          const scaleY = CH / rect.height;
          const mx = (e.clientX - rect.left) * scaleX;
          const my = (e.clientY - rect.top) * scaleY;

          let closest: UnitInstance | null = null;
          let minDist = 16;
          for (const u of units) {
            const h = hm[u.row]?.[u.col] ?? 0;
            const p = proj(u.col + 0.5, u.row + 0.5, h);
            const dist = Math.hypot(p.x - mx, p.y - my);
            if (dist < minDist) {
              minDist = dist;
              closest = u;
            }
          }
          if (closest) onUnitClick(closest.id);
        }}
      />
    </div>
  );
}
