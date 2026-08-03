import { useState, useEffect, useRef } from "react";

// ── Map constants ────────────────────────────────────────────
const COLS = 20, ROWS = 12;

// Isometric projection params
const TW = 20, TH = 10, HS = 13;
const CW = 800, CH = 490;
const OX = 240, OY = 125;

// Height→color palette  (index = height 0..8)
const PAL = [
  "#000c18","#001e30","#003450","#00516e",
  "#00718e","#0094b0","#18b8d4","#48d8f8","#ffb820"
];

// ── Discrete height map: HM[row][col] ─────────────────────────
// Left  cols  0-5  → Team Alpha plateau (H 3-5)
// Center cols 6-7  → West Defile       (H 2)
// Center cols 8-12 → The Ridge         (H 6-8)
// Center cols 13-14→ East Defile       (H 2)
// Right  cols 15-19→ Team Bravo plateau (H 3-5)
const HM = [
  [2,3,4,4,4,3,2,2,6,7,8,7,6,2,2,3,4,4,3,2],
  [2,3,4,5,5,4,2,3,6,7,8,7,6,3,2,4,5,4,3,2],
  [3,4,5,5,5,4,2,3,6,7,8,7,6,3,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,4,6,7,8,7,6,4,2,4,5,5,4,3],
  [3,4,5,5,5,4,2,3,6,7,8,7,6,3,2,4,5,5,4,3],
  [2,3,4,5,5,4,2,3,6,7,8,7,6,3,2,4,5,4,3,2],
  [2,3,4,4,4,3,2,2,6,7,8,7,6,2,2,3,4,4,3,2],
];

// ── Unit definitions ─────────────────────────────────────────
const UNITS = [
  { team:"A", type:"cannon",   col:2,  row:4, lbl:"CNN-1" },
  { team:"A", type:"cannon",   col:2,  row:7, lbl:"CNN-2" },
  { team:"A", type:"catapult", col:1,  row:5, lbl:"CAT"   },
  { team:"A", type:"spotter",  col:5,  row:5, lbl:"SPT"   },
  { team:"B", type:"cannon",   col:17, row:4, lbl:"CNN-1" },
  { team:"B", type:"cannon",   col:17, row:7, lbl:"CNN-2" },
  { team:"B", type:"catapult", col:18, row:5, lbl:"CAT"   },
];

// ── Helpers ──────────────────────────────────────────────────
const proj  = (c,r,h) => ({ x: OX+(c-r)*TW, y: OY+(c+r)*TH-h*HS });
const safeH = (c,r)   => (r>=0&&r<ROWS&&c>=0&&c<COLS) ? HM[r][c] : 0;
const pal   = (h)     => PAL[Math.max(0,Math.min(8,Math.round(h)))];
const rgba  = (hex,a) => {
  const n=parseInt(hex.replace("#",""),16);
  return `rgba(${(n>>16)&255},${(n>>8)&255},${n&255},${a})`;
};

// ── Main component ───────────────────────────────────────────
export default function IronRidgeMap() {
  const canvasRef = useRef(null);
  const [view, setView] = useState("iso");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    // ── Background + scanlines ──────────────────────────────
    ctx.fillStyle = "#000810";
    ctx.fillRect(0, 0, CW, CH);
    for (let y = 0; y < CH; y += 4) {
      ctx.fillStyle = "rgba(0,170,255,0.018)";
      ctx.fillRect(0, y, CW, 1);
    }

    if (view === "iso") drawISO(ctx);
    else               drawData(ctx);

  }, [view]);

  // ── ISO VIEW ─────────────────────────────────────────────
  function drawISO(ctx) {

    // Header
    ctx.fillStyle = "#00ddff";
    ctx.font = 'bold 11px "Courier New",monospace';
    ctx.textAlign = "left";
    ctx.fillText('// IRON RIDGE :: TRAINING SIMULATION :: MAP-01 "THE DEFILE"', 14, 20);
    ctx.fillStyle = "#004455";
    ctx.font = '9px "Courier New",monospace';
    ctx.fillText("GEOMETRY ENGINE ACTIVE  |  GRID 20×12  |  H_RANGE 0–8  |  WIND 3kn NNW  |  SIMULATION MODE", 14, 35);

    // ── Terrain – painter's algo (low col+row = back, drawn first) ──
    for (let sum = 0; sum <= COLS + ROWS - 2; sum++) {
      for (let c = Math.max(0, sum-ROWS+1); c <= Math.min(COLS-1, sum); c++) {
        const r = sum - c;
        const h = HM[r][c];
        const clr = pal(h);

        const p0=proj(c,r,h), p1=proj(c+1,r,h), p2=proj(c+1,r+1,h), p3=proj(c,r+1,h);

        // Top face
        ctx.beginPath();
        ctx.moveTo(p0.x,p0.y); ctx.lineTo(p1.x,p1.y);
        ctx.lineTo(p2.x,p2.y); ctx.lineTo(p3.x,p3.y);
        ctx.closePath();
        ctx.fillStyle   = rgba(clr, h===8 ? 0.30 : 0.13);
        ctx.fill();
        ctx.strokeStyle = rgba(clr, h>=7 ? 0.90 : h>=5 ? 0.65 : 0.48);
        ctx.lineWidth   = h===8 ? 1.1 : 0.65;
        ctx.stroke();

        // South drop face
        const hs = safeH(c, r+1);
        if (h > hs) {
          const s0=proj(c,r+1,h), s1=proj(c+1,r+1,h),
                s2=proj(c+1,r+1,hs), s3=proj(c,r+1,hs);
          ctx.beginPath();
          ctx.moveTo(s0.x,s0.y); ctx.lineTo(s1.x,s1.y);
          ctx.lineTo(s2.x,s2.y); ctx.lineTo(s3.x,s3.y);
          ctx.closePath();
          ctx.fillStyle   = rgba(clr, 0.07);  ctx.fill();
          ctx.strokeStyle = rgba(clr, 0.38);  ctx.lineWidth = 0.38; ctx.stroke();
        }

        // East drop face
        const he = safeH(c+1, r);
        if (h > he) {
          const e0=proj(c+1,r,h),   e1=proj(c+1,r+1,h),
                e2=proj(c+1,r+1,he), e3=proj(c+1,r,he);
          ctx.beginPath();
          ctx.moveTo(e0.x,e0.y); ctx.lineTo(e1.x,e1.y);
          ctx.lineTo(e2.x,e2.y); ctx.lineTo(e3.x,e3.y);
          ctx.closePath();
          ctx.fillStyle   = rgba(clr, 0.04);  ctx.fill();
          ctx.strokeStyle = rgba(clr, 0.38);  ctx.lineWidth = 0.38; ctx.stroke();
        }
      }
    }

    // ── Feature annotations ──────────────────────────────────
    const ann = (c, r, lines, clr, dy=0) => {
      const h = safeH(Math.floor(c), Math.floor(r));
      const p = proj(c+0.5, r+0.5, h);
      ctx.font = 'bold 7.5px "Courier New",monospace';
      ctx.textAlign = "center";
      lines.forEach((ln, i) => {
        ctx.strokeStyle="#000810"; ctx.lineWidth=3;
        ctx.strokeText(ln, p.x, p.y+dy+i*10);
        ctx.fillStyle=clr;
        ctx.fillText(ln,  p.x, p.y+dy+i*10);
      });
    };

    ann( 9.5,  5, ["▲ RIDGE","H:8"],       "#ffaa00", -20);
    ann( 5.5,  5, ["W.DEFILE","H:2"],       "#88cc00",  -4);
    ann(13.5,  5, ["E.DEFILE","H:2"],       "#88cc00",  -4);
    ann( 2.0,  3, ["◈ ALPHA BASE"],         "#00ddff", -14);
    ann(16.5,  3, ["◈ BRAVO BASE"],         "#ff4466", -14);

    // ── Units ────────────────────────────────────────────────
    UNITS.forEach(u => {
      const h = safeH(u.col, u.row);
      const p = proj(u.col+0.5, u.row+0.5, h);
      const clr = u.type==="spotter" ? "#ffff44"
                : u.team==="A"        ? "#00ffff"
                                       : "#ff3355";

      // Glow halo
      const g = ctx.createRadialGradient(p.x,p.y,0, p.x,p.y,12);
      g.addColorStop(0, rgba(clr, 0.55));
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle=g;
      ctx.beginPath(); ctx.arc(p.x,p.y,12,0,Math.PI*2); ctx.fill();

      // Symbol
      ctx.fillStyle = clr;
      if (u.type==="cannon") {
        ctx.fillRect(p.x-4, p.y-4, 8, 8);
      } else if (u.type==="catapult") {
        ctx.beginPath();
        ctx.moveTo(p.x,p.y-6); ctx.lineTo(p.x+5,p.y+4); ctx.lineTo(p.x-5,p.y+4);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath();
        ctx.moveTo(p.x,p.y-5); ctx.lineTo(p.x+4,p.y);
        ctx.lineTo(p.x,p.y+5); ctx.lineTo(p.x-4,p.y);
        ctx.closePath(); ctx.fill();
      }

      // Label
      ctx.font='bold 7px "Courier New",monospace'; ctx.textAlign="center";
      ctx.strokeStyle="#000810"; ctx.lineWidth=2.5;
      ctx.strokeText(u.lbl, p.x, p.y-9);
      ctx.fillStyle=clr;
      ctx.fillText(u.lbl,   p.x, p.y-9);
    });

    // ── Legend panel ─────────────────────────────────────────
    const lx=651, ly=46;
    ctx.fillStyle   = rgba("#000c18", 0.94); ctx.fillRect(lx-5,ly-5,143,400);
    ctx.strokeStyle = "#003344";             ctx.lineWidth=0.8;
    ctx.strokeRect(lx-5,ly-5,143,400);

    const sec = (label, y) => {
      ctx.fillStyle='#00ccdd'; ctx.font='bold 8.5px "Courier New",monospace';
      ctx.textAlign='left'; ctx.fillText(label, lx, y);
    };

    // Height legend
    sec("[ HEIGHT ]", ly+10);
    [
      [8,"Ridge Peak"], [7,"Ridge Hi"], [6,"Ridge Lo"],
      [5,"Hi Plateau"], [4,"Plateau"],  [3,"Slope"],
      [2,"Defile"],     [1,"Valley"],
    ].forEach(([h, lb], i) => {
      const clr=pal(h), by=ly+24+i*23;
      ctx.fillStyle=rgba(clr,0.26); ctx.fillRect(lx,by,15,15);
      ctx.strokeStyle=clr; ctx.lineWidth=0.7; ctx.strokeRect(lx,by,15,15);
      ctx.fillStyle=clr; ctx.font='bold 8px "Courier New",monospace';
      ctx.textAlign="center"; ctx.fillText(h, lx+7.5, by+10.5);
      ctx.fillStyle=rgba(clr,0.82); ctx.font='8px "Courier New",monospace';
      ctx.textAlign="left"; ctx.fillText(lb, lx+21, by+10.5);
    });

    // Unit legend
    sec("[ UNITS ]", ly+217);
    [
      ["#00ffff","sq",  "Cannon  (α)"],
      ["#00ffff","tri", "Catapult (α)"],
      ["#ffff44","dia", "Spotter  (α)"],
      ["#ff3355","sq",  "Cannon  (β)"],
      ["#ff3355","tri", "Catapult (β)"],
    ].forEach(([clr,sym,lb], i) => {
      const ux=lx+7, uy=ly+232+i*19;
      ctx.fillStyle=clr;
      if (sym==="sq")  ctx.fillRect(ux-4,uy-4,7,7);
      else if (sym==="tri") {
        ctx.beginPath(); ctx.moveTo(ux,uy-4); ctx.lineTo(ux+4,uy+3); ctx.lineTo(ux-4,uy+3);
        ctx.closePath(); ctx.fill();
      } else {
        ctx.beginPath(); ctx.moveTo(ux,uy-4); ctx.lineTo(ux+3,uy);
        ctx.lineTo(ux,uy+4); ctx.lineTo(ux-3,uy);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle=rgba(clr,0.82); ctx.font='8px "Courier New",monospace';
      ctx.textAlign="left"; ctx.fillText(lb, ux+11, uy+3.5);
    });

    // Tactical rules
    sec("[ RULES ]", ly+335);
    [
      "CNN: direct LOS req",
      "CAT: arc clearance req",
      "SPT: paints for indirect",
      "Ridge H:8 blocks LOS",
      "Advance SPT past defile",
    ].forEach((t,i) => {
      ctx.fillStyle="#006677"; ctx.font='7.5px "Courier New",monospace';
      ctx.textAlign="left"; ctx.fillText(t, lx, ly+348+i*14);
    });

    // Footer
    ctx.fillStyle="#003344"; ctx.font='8px "Courier New",monospace'; ctx.textAlign="left";
    ctx.fillText("// CNN fire arc blocked by ridge – CAT can lob over – SPT must advance defile to paint", 14, CH-10);
  }

  // ── DATA VIEW ────────────────────────────────────────────
  function drawData(ctx) {
    ctx.fillStyle="#00ddff"; ctx.font='bold 11px "Courier New",monospace'; ctx.textAlign="left";
    ctx.fillText('// HEIGHT MAP :: MAP-01 "THE DEFILE"  ::  COLS=20  ROWS=12  H_MAX=8', 14, 20);
    ctx.fillStyle="#004455"; ctx.font='9px "Courier New",monospace';
    ctx.fillText("discrete integer heights 0–8  |  visual renderer applies bicubic interpolation between tile values", 14, 35);

    const CELL=29, SX=42, SY=52;

    // Col headers
    for (let c=0; c<COLS; c++) {
      ctx.fillStyle="#003344"; ctx.font="7px monospace"; ctx.textAlign="center";
      ctx.fillText(c, SX+c*CELL+CELL/2, SY-6);
    }

    for (let r=0; r<ROWS; r++) {
      // Row header
      ctx.fillStyle="#003344"; ctx.font="7px monospace"; ctx.textAlign="right";
      ctx.fillText(r, SX-6, SY+r*CELL+CELL/2+3);

      for (let c=0; c<COLS; c++) {
        const h  = HM[r][c];
        const clr= pal(h);
        const x  = SX+c*CELL, y = SY+r*CELL;
        const unit = UNITS.find(u=>u.col===c && u.row===r);

        // Cell fill
        ctx.fillStyle=rgba(clr, 0.18); ctx.fillRect(x,y,CELL-1,CELL-1);

        // Border – highlight occupied cells
        ctx.strokeStyle = rgba(clr, unit ? 1.0 : 0.42);
        ctx.lineWidth   = unit ? 1.8 : 0.55;
        ctx.strokeRect(x, y, CELL-1, CELL-1);

        // Height value
        ctx.fillStyle = clr;
        ctx.font = `${h===8?"bold ":""}${h>=7?12:10}px "Courier New",monospace`;
        ctx.textAlign="center";
        ctx.fillText(h, x+CELL/2, y+CELL/2+4);

        // Unit dot (top-right of cell)
        if (unit) {
          const uc = unit.type==="spotter" ? "#ffff44"
                   : unit.team==="A"        ? "#00ffff" : "#ff3355";
          ctx.fillStyle=uc;
          ctx.beginPath(); ctx.arc(x+CELL-5, y+5, 3, 0, Math.PI*2); ctx.fill();
        }
      }
    }

    // ── Feature callouts on grid ──────────────────────────
    const callout = (c, r, txt, clr) => {
      const x=SX+c*CELL+CELL/2, y=SY+r*CELL-3;
      ctx.fillStyle=clr; ctx.font='bold 6.5px monospace'; ctx.textAlign="center";
      ctx.strokeStyle="#000810"; ctx.lineWidth=2.5;
      ctx.strokeText(txt,x,y); ctx.fillText(txt,x,y);
    };
    callout(10, 0, "▲ PEAK",    "#ffaa00");
    callout( 6, 0, "▼ DEFL",    "#88cc00");
    callout(14, 0, "▼ DEFL",    "#88cc00");
    callout( 3, 0, "α BASE",    "#00ddff");
    callout(17, 0, "β BASE",    "#ff4466");

    // ── Height key bar ─────────────────────────────────────
    const KY = SY + ROWS*CELL + 14;
    ctx.fillStyle="#00ccdd"; ctx.font='bold 8px "Courier New",monospace'; ctx.textAlign="left";
    ctx.fillText("H KEY:", 14, KY+11);

    [1,2,3,4,5,6,7,8].forEach((h,i) => {
      const clr=pal(h), kx=68+i*88;
      ctx.fillStyle=rgba(clr,0.22); ctx.fillRect(kx,KY,22,15);
      ctx.strokeStyle=clr; ctx.lineWidth=0.7; ctx.strokeRect(kx,KY,22,15);
      ctx.fillStyle=clr; ctx.font=`${h===8?"bold ":""}9px monospace`;
      ctx.textAlign="center"; ctx.fillText(h, kx+11, KY+11);
      const tag={1:"Valley",2:"Defile",3:"Slope",4:"Plateau",5:"Hi-Plt",6:"Rdg-Lo",7:"Rdg-Hi",8:"PEAK"};
      ctx.fillStyle=rgba(clr,0.7); ctx.font="6.5px monospace";
      ctx.fillText(tag[h], kx+11, KY+24);
    });

    // Dot legend
    const DY = KY + 36;
    [["#00ffff","●","Cannon/Cat (α)"],["#ffff44","●","Spotter (α)"],["#ff3355","●","Unit (β)"]].forEach(([c,sym,lb],i)=>{
      ctx.fillStyle=c; ctx.font="9px monospace"; ctx.textAlign="left";
      ctx.fillText(sym, 14+i*170, DY);
      ctx.fillStyle=rgba(c,0.7); ctx.font='8px "Courier New",monospace';
      ctx.fillText(lb, 26+i*170, DY);
    });

    ctx.fillStyle="#003344"; ctx.font='8px "Courier New",monospace'; ctx.textAlign="left";
    ctx.fillText("// ● top-right = unit occupying tile  |  bright border = occupied  |  col 10 H:8 = ridge peak  |  cols 6,14 H:2 = defiles", 14, CH-10);
  }

  // ── JSX ──────────────────────────────────────────────────
  const btn = (v, label) => (
    <button key={v} onClick={()=>setView(v)} style={{
      background:    view===v ? "#009aaa" : "transparent",
      color:         view===v ? "#000810" : "#009aaa",
      border:        "1px solid #009aaa",
      padding:       "5px 16px",
      cursor:        "pointer",
      fontFamily:    '"Courier New",monospace',
      fontSize:      10,
      letterSpacing: 1,
    }}>{label}</button>
  );

  return (
    <div style={{
      background:"#000810", minHeight:"100vh",
      display:"flex", flexDirection:"column", alignItems:"center",
      padding:"10px 6px", fontFamily:'"Courier New",monospace',
    }}>
      <div style={{ display:"flex", gap:8, marginBottom:8, width:"100%", maxWidth:CW }}>
        {btn("iso","[ ISOMETRIC VIEW ]")}
        {btn("data","[ DATA GRID ]")}
        <span style={{ color:"#003344", fontSize:8, lineHeight:"26px", marginLeft:8 }}>
          {view==="iso" ? "RENDERED TOPOLOGY" : "RAW HEIGHT VALUES"}
        </span>
      </div>

      <canvas
        ref={canvasRef}
        width={CW} height={CH}
        style={{ display:"block", maxWidth:"100%", border:"1px solid #002233" }}
      />

      <div style={{ marginTop:8, color:"#003344", fontSize:8, width:"100%", maxWidth:CW, lineHeight:1.8 }}>
        <div>{"// DATA SCHEMA: HM[row][col] → int (0–8)  |  renderer: bicubic interpolation over discrete tile grid"}</div>
        <div>{"// RIDGE cols 8–12 (H 6–8)  |  W.DEFILE col 6 (H 2)  |  E.DEFILE col 14 (H 2)  |  α cols 2–4  |  β cols 15–18"}</div>
        <div>{"// TACTICAL: CNN LOS blocked by ridge  →  CAT must arc over H:8  →  SPT advances defile to paint β for indirect fire"}</div>
      </div>
    </div>
  );
}
