// オシロスコープ風の表示部 (10 x 8 div グラティクル、トリガ / 基準マーカー、カーソル、FFT ペイン)
import { fmtHz } from "./sim.js";

const C = {
  bg: "#000", grid: "#3b3b3b", axis: "#6a6a6a", text: "#d9d9d9", dim: "#8a8a8a",
  trig: "#ff9b21", cursor: "#ff9b21", cursorHot: "#ffd27a", fft: "#c27dff",
};
const MONO = "ui-monospace, Consolas, 'Roboto Mono', monospace";
const SANS = "system-ui, 'Segoe UI', 'Yu Gothic UI', 'Noto Sans JP', sans-serif";
const DIVX = 10, DIVY = 8;

export class Scope {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.onCursor = null;           // (name, frac) => void
    this.cursors = null;
    this.layout = null;
    this.drag = null;
    canvas.addEventListener("pointerdown", (e) => this._down(e));
    canvas.addEventListener("pointermove", (e) => this._move(e));
    const up = (e) => { if (this.drag) { this.drag = null; try { canvas.releasePointerCapture(e.pointerId); } catch {} } };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
  }

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    const w = Math.max(Math.round(r.width), 200), h = Math.max(Math.round(r.height), 150);
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) {
      this.cv.width = Math.round(w * dpr);
      this.cv.height = Math.round(h * dpr);
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.fs = w < 520 ? 10 : 11;
  }

  _text(s, x, y, { color = C.text, align = "left", base = "middle", mono = true, bold = false, size } = {}) {
    const c = this.ctx;
    c.font = `${bold ? "bold " : ""}${size || this.fs}px ${mono ? MONO : SANS}`;
    c.fillStyle = color;
    c.textAlign = align;
    c.textBaseline = base;
    c.fillText(s, x, y);
    return c.measureText(s).width;
  }

  _graticule(r) {
    const c = this.ctx, { x, y, w, h } = r;
    c.fillStyle = C.bg;
    c.fillRect(x, y, w, h);
    c.lineWidth = 1;
    c.strokeStyle = C.grid;
    c.setLineDash([1, 3]);
    for (let i = 1; i < DIVX; i++) {
      if (i === DIVX / 2) continue;
      const px = Math.round(x + (w * i) / DIVX) + 0.5;
      c.beginPath(); c.moveTo(px, y); c.lineTo(px, y + h); c.stroke();
    }
    for (let j = 1; j < DIVY; j++) {
      if (j === DIVY / 2) continue;
      const py = Math.round(y + (h * j) / DIVY) + 0.5;
      c.beginPath(); c.moveTo(x, py); c.lineTo(x + w, py); c.stroke();
    }
    c.setLineDash([]);
    // center axes with 0.2 div ticks
    const cx = Math.round(x + w / 2) + 0.5, cy = Math.round(y + h / 2) + 0.5;
    c.strokeStyle = C.axis;
    c.beginPath(); c.moveTo(cx, y); c.lineTo(cx, y + h); c.moveTo(x, cy); c.lineTo(x + w, cy); c.stroke();
    c.beginPath();
    for (let i = 0; i <= DIVX * 5; i++) {
      const px = Math.round(x + (w * i) / (DIVX * 5)) + 0.5, l = i % 5 ? 3 : 5;
      c.moveTo(px, cy - l); c.lineTo(px, cy + l);
    }
    for (let j = 0; j <= DIVY * 5; j++) {
      const py = Math.round(y + (h * j) / (DIVY * 5)) + 0.5, l = j % 5 ? 3 : 5;
      c.moveTo(cx - l, py); c.lineTo(cx + l, py);
    }
    c.stroke();
    c.strokeStyle = "#4a4a4a";
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  // 1 ピクセル列ごとに min/max を求めて連続線で描く
  _trace(r, t0, tw, ch, span, color, width) {
    const c = this.ctx, { x, y, w, h } = r;
    const divH = h / DIVY, cy = y + h / 2;
    const Y = (v) => cy - (v / ch.vdiv + ch.pos) * divH;
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.strokeStyle = color;
    c.lineWidth = width;
    c.lineJoin = "round";
    c.beginPath();
    let prev = null;
    const cols = Math.max(1, Math.round(w));
    for (let i = 0; i < cols; i++) {
      const ta = t0 + (tw * i) / cols, tb = t0 + (tw * (i + 1)) / cols;
      const [lo, hi] = span(ta, tb);
      const ya = Y(lo), yb = Y(hi), px = x + i + 0.5;
      let p1 = ya, p2 = yb;
      if (prev !== null && Math.abs(prev - yb) < Math.abs(prev - ya)) { p1 = yb; p2 = ya; }
      if (prev === null) c.moveTo(px, p1); else c.lineTo(px, p1);
      if (p2 !== p1) c.lineTo(px, p2);
      prev = p2;
    }
    c.stroke();
    c.restore();
  }

  _groundMarker(r, ch) {
    const c = this.ctx, { x, y, h } = r;
    const divH = h / DIVY;
    let py = y + h / 2 - ch.pos * divH;
    const off = py < y + 6 ? -1 : py > y + h - 6 ? 1 : 0;
    py = Math.min(Math.max(py, y + 7), y + h - 7);
    const px = x + 1;
    c.fillStyle = ch.color;
    c.beginPath();
    c.moveTo(px, py - 7); c.lineTo(px + 12, py - 7); c.lineTo(px + 18, py); c.lineTo(px + 12, py + 7); c.lineTo(px, py + 7);
    c.closePath(); c.fill();
    this._text(off ? (off < 0 ? "↑" : "↓") : ch.id, px + 6, py + 0.5, { color: "#000", align: "center", bold: true, size: 10 });
  }

  _trigMarkers(r, f) {
    const c = this.ctx, { x, y, w, h } = r;
    const cx = x + w / 2;     // trigger position: center
    c.fillStyle = C.trig;
    c.beginPath(); c.moveTo(cx - 6, y); c.lineTo(cx + 6, y); c.lineTo(cx, y + 8); c.closePath(); c.fill();
    if (!f.trig || !f.trig.ch) return;
    const ch = f.trig.ch;
    const divH = h / DIVY;
    let py = y + h / 2 - (f.trig.level / ch.vdiv + ch.pos) * divH;
    py = Math.min(Math.max(py, y + 7), y + h - 7);
    const px = x + w - 1;
    c.fillStyle = ch.color;
    c.beginPath(); c.moveTo(px, py - 7); c.lineTo(px - 12, py - 7); c.lineTo(px - 18, py); c.lineTo(px - 12, py + 7); c.lineTo(px, py + 7);
    c.closePath(); c.fill();
    this._text("T", px - 6, py + 0.5, { color: "#000", align: "center", bold: true, size: 10 });
  }

  _cursors(r, f) {
    const cu = f.cursors;
    if (!cu || cu.mode === "off") return;
    const c = this.ctx, { x, y, w, h } = r;
    c.save();
    c.setLineDash([5, 4]);
    c.lineWidth = 1.2;
    const hot = this.drag && this.drag.name;
    const line = (name, vertical, frac) => {
      c.strokeStyle = hot === name ? C.cursorHot : C.cursor;
      c.beginPath();
      if (vertical) { const px = Math.round(x + frac * w) + 0.5; c.moveTo(px, y); c.lineTo(px, y + h); }
      else { const py = Math.round(y + frac * h) + 0.5; c.moveTo(x, py); c.lineTo(x + w, py); }
      c.stroke();
      if (vertical) this._text(name, x + frac * w + 3, y + h - 9, { color: C.cursor, size: 10 });
      else this._text(name, x + w - 22, y + frac * h - 7, { color: C.cursor, size: 10 });
    };
    if (cu.mode === "x" || cu.mode === "xy") { line("X1", true, cu.x1); line("X2", true, cu.x2); }
    if (cu.mode === "y" || cu.mode === "xy") { line("Y1", false, cu.y1); line("Y2", false, cu.y2); }
    c.restore();
  }

  _phasor(r, p) {
    const c = this.ctx;
    const rad = Math.min(42, r.h / 5);
    const cx = r.x + r.w - rad - 34, cy = r.y + rad + 20;
    c.save();
    c.fillStyle = "rgba(0,0,0,.8)";
    c.fillRect(cx - rad - 14, cy - rad - 12, 2 * rad + 28, 2 * rad + 36);
    c.strokeStyle = "#555"; c.lineWidth = 1;
    c.beginPath(); c.arc(cx, cy, rad, 0, 2 * Math.PI); c.stroke();
    const axes = p.rev ? [["U", 0], ["W", 120], ["V", 240]] : [["U", 0], ["V", 120], ["W", 240]];
    for (const [n, a] of axes) {
      const t = (-a * Math.PI) / 180;
      c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + rad * Math.cos(t), cy + rad * Math.sin(t)); c.stroke();
      this._text(n, cx + (rad + 7) * Math.cos(t), cy + (rad + 7) * Math.sin(t), { color: C.dim, align: "center", size: 10 });
    }
    const a = -(p.theta - Math.PI / 2);   // 空間ベクトルの向き = θ − 90°
    c.strokeStyle = C.fft; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + rad * 0.9 * Math.cos(a), cy + rad * 0.9 * Math.sin(a)); c.stroke();
    c.restore();
    this._text("磁界の向き", cx, cy + rad + 15, { color: C.dim, align: "center", mono: false, size: 10 });
  }

  _fftPane(r, f) {
    this._graticule(r);
    const fx = f.fft;
    const c = this.ctx, { x, y, w, h } = r;
    const { db, df } = fx.sp;
    const fmax = fx.fmax;
    const top = fx.refDb, dbDiv = 10;
    const Y = (d) => y + ((top - d) / (dbDiv * DIVY)) * h;
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.strokeStyle = C.fft; c.lineWidth = 1.2;
    c.beginPath();
    const cols = Math.round(w);
    let started = false;
    for (let i = 0; i < cols; i++) {
      const k0 = Math.floor(((i / cols) * fmax) / df);
      const k1 = Math.max(k0 + 1, Math.floor((((i + 1) / cols) * fmax) / df));
      let m = -Infinity;
      for (let k = k0; k < k1 && k < db.length; k++) if (db[k] > m) m = db[k];
      if (!isFinite(m)) continue;
      const py = Y(m);
      if (!started) { c.moveTo(x + i, py); started = true; } else c.lineTo(x + i, py);
    }
    c.stroke();
    (fx.peaks || []).forEach((p, i) => {
      if (p.f > fmax) return;
      const px = x + (p.f / fmax) * w, py = Y(p.db);
      c.fillStyle = "#fff";
      c.beginPath(); c.moveTo(px - 4, py - 10); c.lineTo(px + 4, py - 10); c.lineTo(px, py - 4); c.closePath(); c.fill();
      this._text(String(i + 1), px, py - 17, { color: "#fff", align: "center", size: 10 });
    });
    c.restore();
    this._text(`FFT(${fx.src})  ${fx.winLabel}  ${dbDiv}dB/  Ref ${top}dBV`, x + 6, y + 10, { color: C.fft, size: 10 });
    this._text("0Hz", x + 4, y + h - 9, { color: C.dim, size: 10 });
    this._text(fmtHz(fmax / 2), x + w / 2, y + h - 9, { color: C.dim, align: "center", size: 10 });
    this._text(fmtHz(fmax), x + w - 4, y + h - 9, { color: C.dim, align: "right", size: 10 });
    this._text(`${fmtHz(fmax / DIVX)}/div`, x + w - 4, y + 10, { color: C.dim, align: "right", size: 10 });
  }

  // f = { channels, t0, tw, trig, fft, cursors, phasor, note }
  draw(f) {
    this._resize();
    const c = this.ctx, W = this.W, H = this.H;
    c.fillStyle = "#000";
    c.fillRect(0, 0, W, H);
    const gap = 6;
    const tH = f.fft ? Math.round((H - gap) * 0.56) : H;
    const tr = { x: 0, y: 0, w: W, h: tH };
    this.layout = tr;
    this._graticule(tr);
    for (const ch of f.channels) {
      for (const ex of ch.extra || []) this._trace(tr, f.t0, f.tw, ch, ex.span, ex.color, 1.3);
      this._trace(tr, f.t0, f.tw, ch, ch.span, ch.color, 1.6);
    }
    f.channels.forEach((ch) => this._groundMarker(tr, ch));
    this._trigMarkers(tr, f);
    if (f.phasor) this._phasor(tr, f.phasor);
    this._cursors(tr, f);
    if (f.note) this._text(f.note, tr.x + tr.w / 2, tr.y + tr.h / 2 - 20, { color: C.text, align: "center", mono: false });
    if (f.fft) this._fftPane({ x: 0, y: tH + gap, w: W, h: H - tH - gap }, f);
    this.cursors = f.cursors;
  }

  // ---------------- cursor dragging ----------------
  _pos(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  _down(e) {
    const cu = this.cursors;
    if (!cu || cu.mode === "off" || !this.layout) return;
    const [px, py] = this._pos(e);
    const L = this.layout;
    if (py > L.y + L.h) return;
    const fx = (px - L.x) / L.w, fy = (py - L.y) / L.h;
    const cand = [];
    if (cu.mode === "x" || cu.mode === "xy") cand.push(["X1", Math.abs(fx - cu.x1) * L.w], ["X2", Math.abs(fx - cu.x2) * L.w]);
    if (cu.mode === "y" || cu.mode === "xy") cand.push(["Y1", Math.abs(fy - cu.y1) * L.h], ["Y2", Math.abs(fy - cu.y2) * L.h]);
    cand.sort((a, b) => a[1] - b[1]);
    this.drag = { name: cand[0][0] };
    try { this.cv.setPointerCapture(e.pointerId); } catch {}
    this._move(e);
    e.preventDefault();
  }
  _move(e) {
    if (!this.drag || !this.layout) return;
    const [px, py] = this._pos(e);
    const L = this.layout;
    const n = this.drag.name;
    const frac = n[0] === "X" ? (px - L.x) / L.w : (py - L.y) / L.h;
    if (this.onCursor) this.onCursor(n, Math.min(Math.max(frac, 0), 1));
  }
}
