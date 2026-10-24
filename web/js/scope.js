// オシロスコープ風の表示部 (10 x 8 div グラティクル、トリガ / 基準マーカー、カーソル、FFT ペイン)
//
// 画面上の操作 (優先順):
//   トリガのマーカー (右端 T = レベル、上端 ▼ = 位置) のドラッグ → 近いカーソルのドラッグ
//   → 端のクリック (時間波形: 左右 = 時間軸、FFT: 左右 = スパン / 上下 = dB/div) → カーソル移動
import { fmtHz } from "./sim.js";

const C = {
  bg: "#000", grid: "#3b3b3b", axis: "#6a6a6a", text: "#d9d9d9", dim: "#8a8a8a",
  trig: "#ff9b21", cursor: "#ff9b21", cursorHot: "#ffd27a", fft: "#c27dff",
};
const MONO = "ui-monospace, Consolas, 'Roboto Mono', monospace";
const SANS = "system-ui, 'Segoe UI', 'Yu Gothic UI', 'Noto Sans JP', sans-serif";
const DIVX = 10, DIVY = 8;
const ZONE = 0.15;        // 時間波形: 左右この割合のクリックで時間軸
const FZONE_X = 0.12;     // FFT: 左右 (スパン)
const FZONE_Y = 0.15;     // FFT: 上下 (dB/div)
const NEAR_PX = 14;       // これより近いカーソル / マーカーはドラッグを優先
// 指 / ペンは位置がずれやすく、当たり判定も大きく取る
const TOUCH = { near: 28, tap: 24, tapMs: 600, zone: 0.2, fzoneX: 0.16, fzoneY: 0.2, markW: 44 };
const MOUSE = { near: NEAR_PX, tap: 8, tapMs: Infinity, zone: ZONE, fzoneX: FZONE_X, fzoneY: FZONE_Y, markW: 26 };

export class Scope {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d");
    this.onCursor = null;           // (name, frac)
    this.onZoom = null;             // (dir)  +1: 拡大 / -1: 縮小
    this.onFftZoom = null;          // (axis "x"|"y", dir)  +1: 拡大
    this.onTrigLevel = null;        // (volts)
    this.onTrigPos = null;          // (frac 0..1)
    this.onRepaint = null;          // ホバー表示の更新
    this.hover = "";
    this.pending = null;            // クリック待ちの端の操作
    this.wheelAcc = 0;
    this.cursors = null;
    this.layout = null;
    this.fftLayout = null;
    this.trig = null;               // { y (レベルの画面位置), x (位置), ch }
    this.drag = null;
    this.touches = new Map();       // タッチ中の指 (ピンチ用)
    this.pinch = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, this._pos(e));
        if (this.touches.size === 2) { this._startPinch(); e.preventDefault(); return; }
        if (this.touches.size > 2) return;
      }
      this._down(e);
    });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch" && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, this._pos(e));
        if (this.pinch) { this._movePinch(); return; }
      }
      this._move(e);
    });
    const up = (e) => {
      const wasPinch = !!this.pinch;
      if (e.pointerType === "touch") {
        this.touches.delete(e.pointerId);
        if (this.touches.size < 2) this.pinch = null;
      }
      // ドラッグはその位置で確定済み (pointercancel でも値は残す)
      if (this.drag) {
        const dr = this.drag;
        this.drag = null;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
        // マーカー / カーソルに触れただけで動かさなかった → 端のタップとして扱う
        if (!dr.active && dr.zone && e.type === "pointerup" && !wasPinch &&
            performance.now() - dr.t < (dr.touch ? TOUCH : MOUSE).tapMs) {
          const z = dr.zone;
          if (z.pane === "t" && this.onZoom) this.onZoom(z.dir);
          if (z.pane === "f" && this.onFftZoom) this.onFftZoom(z.axis, z.dir);
        }
        if (this.onRepaint) this.onRepaint();
      }
      const z = this.pending;
      this.pending = null;
      if (z && e.type === "pointerup" && !wasPinch) {
        const [px, py] = this._pos(e);
        const tol = z.touch ? TOUCH : MOUSE;
        if (Math.hypot(px - z.x, py - z.y) < tol.tap && performance.now() - z.t < tol.tapMs) {
          if (z.pane === "t" && this.onZoom) this.onZoom(z.dir);
          if (z.pane === "f" && this.onFftZoom) this.onFftZoom(z.axis, z.dir);
        }
      }
    };
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointercancel", up);
    canvas.addEventListener("pointerleave", () => this._setHover(""));
    canvas.addEventListener("wheel", (e) => {
      if (!this.layout) return;
      const [, py] = this._pos(e);
      const inFft = this.fftLayout && py >= this.fftLayout.y;
      if (inFft ? !this.onFftZoom : !this.onZoom) return;
      e.preventDefault();
      this.wheelAcc += e.deltaY;
      if (Math.abs(this.wheelAcc) >= 60) {
        const dir = this.wheelAcc < 0 ? 1 : -1;     // 上 = 拡大
        if (inFft) this.onFftZoom("x", dir); else this.onZoom(dir);
        this.wheelAcc = 0;
      }
    }, { passive: false });
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

  // 1 ピクセル列ごとに値を求めて連続線で描く (span: 包絡線 [min, max]、avg: 平均値)
  _trace(r, t0, tw, ch, src, color, width, mode) {
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
      const px = x + i + 0.5;
      if (mode === "avg") {
        const py = Y(src.avg((ta + tb) / 2));
        if (prev === null) c.moveTo(px, py); else c.lineTo(px, py);
        prev = py;
        continue;
      }
      const [lo, hi] = src.span(ta, tb);
      const ya = Y(lo), yb = Y(hi);
      let p1 = ya, p2 = yb;
      if (prev !== null && Math.abs(prev - yb) < Math.abs(prev - ya)) { p1 = yb; p2 = ya; }
      if (prev === null) c.moveTo(px, p1); else c.lineTo(px, p1);
      if (p2 !== p1) c.lineTo(px, p2);
      prev = p2;
    }
    c.stroke();
    c.restore();
  }

  // 取込モード: normal = 包絡線、hires = 平均、auto = 詰まったら包絡線を薄くして平均を重ねる
  _channel(r, f, ch, src, color, width) {
    // 1 ピクセルにスイッチング周期の 1/5 以上入る (= 1 周期が 5 px 未満) と包絡線が帯になる
    const dense = src.fsw && src.avg && f.tw / Math.max(1, r.w) >= 0.2 / src.fsw;
    const acq = f.acq || "auto";
    if (!src.avg || acq === "normal" || (acq === "auto" && !dense)) {
      this._trace(r, f.t0, f.tw, ch, src, color, width, "span");
      return false;
    }
    if (acq === "auto") {
      this.ctx.save();
      this.ctx.globalAlpha = 0.28;
      this._trace(r, f.t0, f.tw, ch, src, color, width, "span");
      this.ctx.restore();
    }
    this._trace(r, f.t0, f.tw, ch, src, color, width + 0.4, "avg");
    return true;
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
    const tpos = f.tpos ?? 0.5;
    const cx = x + tpos * w;
    const hotP = this.hover === "TP" || (this.drag && this.drag.name === "TP");
    c.fillStyle = hotP ? "#ffd27a" : C.trig;
    c.beginPath(); c.moveTo(cx - 7, y); c.lineTo(cx + 7, y); c.lineTo(cx, y + 9); c.closePath(); c.fill();
    if (hotP || (this.drag && this.drag.name === "TP")) {
      c.save(); c.setLineDash([2, 3]); c.strokeStyle = "rgba(255,155,33,.6)";
      c.beginPath(); c.moveTo(cx + 0.5, y); c.lineTo(cx + 0.5, y + h); c.stroke(); c.restore();
    }
    this.trig = { x: cx, y: null, ch: null };
    if (!f.trig || !f.trig.ch) return;
    const ch = f.trig.ch;
    const divH = h / DIVY;
    let py = y + h / 2 - (f.trig.level / ch.vdiv + ch.pos) * divH;
    py = Math.min(Math.max(py, y + 7), y + h - 7);
    const px = x + w - 1;
    const hotL = this.hover === "TL" || (this.drag && this.drag.name === "TL");
    if (hotL) {
      c.save(); c.setLineDash([2, 3]); c.strokeStyle = ch.color;
      c.beginPath(); c.moveTo(x, py + 0.5); c.lineTo(x + w, py + 0.5); c.stroke(); c.restore();
    }
    c.fillStyle = ch.color;
    c.beginPath(); c.moveTo(px, py - 7); c.lineTo(px - 12, py - 7); c.lineTo(px - 18, py); c.lineTo(px - 12, py + 7); c.lineTo(px, py + 7);
    c.closePath(); c.fill();
    this._text("T", px - 6, py + 0.5, { color: "#000", align: "center", bold: true, size: 10 });
    this.trig = { x: cx, y: py, ch };
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
      else this._text(name, x + w - 44, y + frac * h - 7, { color: C.cursor, size: 10 });
    };
    if (cu.mode === "x" || cu.mode === "xy") { line("X1", true, cu.x1); line("X2", true, cu.x2); }
    if (cu.mode === "y" || cu.mode === "xy") { line("Y1", false, cu.y1); line("Y2", false, cu.y2); }
    c.restore();
  }

  // 端のクリック操作の目印
  _hint(label, px, py, key, align = "center") {
    const hot = this.hover === key;
    this._text(label, px, py, { color: hot ? "rgba(255,255,255,.9)" : "rgba(255,255,255,.22)", align, mono: false, size: 11 });
  }
  _hotBand(key, x, y, w, h) {
    if (this.hover !== key) return;
    this.ctx.fillStyle = "rgba(255,255,255,.05)";
    this.ctx.fillRect(x, y, w, h);
  }
  _zoomHints(r) {
    if (!this.onZoom) return;
    const { x, y, w, h } = r;
    this._hotBand("t-1", x, y, w * ZONE, h);
    this._hotBand("t1", x + w * (1 - ZONE), y, w * ZONE, h);
    this._hint("◀ 縮小", x + 8, y + h / 2 + 14, "t-1", "left");
    this._hint("拡大 ▶", x + w - 8, y + h / 2 + 14, "t1", "right");
  }
  _fftHints(r) {
    if (!this.onFftZoom) return;
    const { x, y, w, h } = r;
    this._hotBand("fx-1", x, y, w * FZONE_X, h);
    this._hotBand("fx1", x + w * (1 - FZONE_X), y, w * FZONE_X, h);
    this._hotBand("fy1", x + w * FZONE_X, y, w * (1 - 2 * FZONE_X), h * FZONE_Y);
    this._hotBand("fy-1", x + w * FZONE_X, y + h * (1 - FZONE_Y), w * (1 - 2 * FZONE_X), h * FZONE_Y);
    this._hint("◀ 広く", x + 8, y + h / 2, "fx-1", "left");
    this._hint("狭く ▶", x + w - 8, y + h / 2, "fx1", "right");
    this._hint("▲ 縦 拡大", x + w / 2, y + 24, "fy1");
    this._hint("▼ 縦 縮小", x + w / 2, y + h - 24, "fy-1");
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
    const top = fx.refDb, dbDiv = fx.dbDiv || 10;
    const Y = (d) => y + ((top - d) / (dbDiv * DIVY)) * h;
    if (fx.empty) {
      this._text(fx.empty, x + w / 2, y + h / 2 - 16, { color: C.text, align: "center", mono: false });
      this._text("出力を ON にするか、表示メニュー → 設定プレビュー で設定値を表示", x + w / 2, y + h / 2 + 6,
                 { color: C.dim, align: "center", mono: false, size: 11 });
    }
    c.save();
    c.beginPath(); c.rect(x, y, w, h); c.clip();
    c.strokeStyle = fx.empty ? "transparent" : C.fft; c.lineWidth = 1.2;
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
    this._text(`FFT(${fx.src})  ${fx.winLabel}  ${dbDiv}dB/  Ref ${top}dBV  Δf ${fmtHz(df)}`, x + 6, y + 10, { color: C.fft, size: 10 });
    for (let i = 0; i <= DIVX; i += 2) {
      const lbl = i === 0 ? "0Hz" : fmtHz((fmax * i) / DIVX);
      const px = i === 0 ? x + 4 : i === DIVX ? x + w - 4 : x + (w * i) / DIVX;
      this._text(lbl, px, y + h - 9, { color: C.dim, align: i === 0 ? "left" : i === DIVX ? "right" : "center", size: 10 });
    }
    this._text(`${fmtHz(fmax / DIVX)}/div`, x + w - 4, y + 10, { color: C.dim, align: "right", size: 10 });
    this._fftHints(r);
  }

  // f = { channels, t0, tw, tpos, trig, fft, cursors, phasor, note, acq }
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
    this._zoomHints(tr);
    let hires = false;
    for (const ch of f.channels) {
      for (const ex of ch.extra || []) hires = this._channel(tr, f, ch, ex, ex.color, 1.3) || hires;
      hires = this._channel(tr, f, ch, ch, ch.color, 1.6) || hires;
    }
    f.channels.forEach((ch) => this._groundMarker(tr, ch));
    this._trigMarkers(tr, f);
    if (f.phasor) this._phasor(tr, f.phasor);
    this._cursors(tr, f);
    if (f.note) this._text(f.note, tr.x + tr.w / 2, tr.y + tr.h / 2 - 20, { color: C.text, align: "center", mono: false });
    if (f.fft) {
      this.fftLayout = { x: 0, y: tH + gap, w: W, h: H - tH - gap };
      this._fftPane(this.fftLayout, f);
    } else {
      this.fftLayout = null;
    }
    this.cursors = f.cursors;
    return { hires };
  }

  // ---------------- pointer ----------------
  _pos(e) {
    const r = this.cv.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  // 位置にある操作対象を調べる
  // 端のゾーン (時間波形: 左右 = 時間軸 / FFT: 左右 = スパン、上下 = dB/div)
  _zoneAt(px, py, tol) {
    const L = this.layout, F = this.fftLayout;
    if (F && py >= F.y) {
      const fx = (px - F.x) / F.w, fy = (py - F.y) / F.h;
      if (fx < tol.fzoneX) return { key: "fx-1", pane: "f", axis: "x", dir: -1 };
      if (fx > 1 - tol.fzoneX) return { key: "fx1", pane: "f", axis: "x", dir: 1 };
      if (fy < tol.fzoneY) return { key: "fy1", pane: "f", axis: "y", dir: 1 };
      if (fy > 1 - tol.fzoneY) return { key: "fy-1", pane: "f", axis: "y", dir: -1 };
      return null;
    }
    if (!L || py > L.y + L.h || !this.onZoom) return null;
    const zx = (px - L.x) / L.w;
    if (zx < tol.zone) return { key: "t-1", pane: "t", dir: -1 };
    if (zx > 1 - tol.zone) return { key: "t1", pane: "t", dir: 1 };
    return null;
  }

  _target(px, py, touch = false) {
    const tol = touch ? TOUCH : MOUSE;
    const L = this.layout, F = this.fftLayout;
    const zone = this._zoneAt(px, py, tol);
    if (F && py >= F.y) return zone;
    if (!L || py > L.y + L.h) return null;
    const T = this.trig;
    const markR = touch ? tol.near : 12;
    if (T && T.y !== null && this.onTrigLevel && px >= L.x + L.w - tol.markW && Math.abs(py - T.y) <= markR) return { key: "TL", drag: "TL", zone };
    if (T && this.onTrigPos && py <= L.y + (touch ? 34 : 18) && Math.abs(px - T.x) <= markR) return { key: "TP", drag: "TP", zone };
    const cu = this.cursors;
    if (cu && cu.mode !== "off") {
      const fx = (px - L.x) / L.w, fy = (py - L.y) / L.h;
      const cand = [];
      if (cu.mode === "x" || cu.mode === "xy") cand.push(["X1", Math.abs(fx - cu.x1) * L.w], ["X2", Math.abs(fx - cu.x2) * L.w]);
      if (cu.mode === "y" || cu.mode === "xy") cand.push(["Y1", Math.abs(fy - cu.y1) * L.h], ["Y2", Math.abs(fy - cu.y2) * L.h]);
      cand.sort((a, b) => a[1] - b[1]);
      if (cand[0][1] <= tol.near) return { key: cand[0][0], drag: cand[0][0], zone };
      if (zone) return zone;
      return { key: "", drag: cand[0][0], immediate: true };   // 遠くても最寄りのカーソルをその位置へ
    }
    return zone;
  }

  // 2 本指のピンチ: 広げる = 拡大、すぼめる = 縮小 (時間波形は時間軸、FFT はスパン)
  _startPinch() {
    this.pending = null;
    this.drag = null;
    const [a, b] = [...this.touches.values()];
    const midY = (a[1] + b[1]) / 2;
    this.pinch = { d0: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, fft: !!(this.fftLayout && midY >= this.fftLayout.y) };
  }
  _movePinch() {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    const r = d / this.pinch.d0;
    if (r > 1.3 || r < 0.77) {
      const dir = r > 1 ? 1 : -1;
      if (this.pinch.fft) { if (this.onFftZoom) this.onFftZoom("x", dir); }
      else if (this.onZoom) this.onZoom(dir);
      this.pinch.d0 = d;
    }
  }

  _setHover(key) {
    if (key === this.hover) return;
    this.hover = key;
    this.cv.style.cursor = key === "TL" ? "ns-resize" : key === "TP" ? "ew-resize" : key ? "pointer" : "";
    if (this.onRepaint) this.onRepaint();
  }

  _down(e) {
    const [px, py] = this._pos(e);
    const touch = e.pointerType !== "mouse";
    const t = this._target(px, py, touch);
    if (!t) return;
    e.preventDefault();                 // ダブルタップ拡大・互換マウスイベントを防ぐ
    if (t.drag) {
      // 実際に動かすまでは値を変えない (触れただけでトリガレベルが指の位置へ飛ばないように)
      this.drag = { name: t.drag, x0: px, y0: py, active: !!t.immediate, zone: t.zone || null, touch, t: performance.now() };
      try { this.cv.setPointerCapture(e.pointerId); } catch {}
      if (this.drag.active) this._move(e);
      return;
    }
    this.pending = { ...t, x: px, y: py, t: performance.now(), touch };
  }

  _move(e) {
    const [px, py] = this._pos(e);
    if (!this.drag) {
      if (e.pointerType === "mouse") { const t = this._target(px, py); this._setHover(t && t.key ? t.key : ""); }
      return;
    }
    const dr = this.drag;
    if (!dr.active) {
      if (Math.hypot(px - dr.x0, py - dr.y0) < (dr.touch ? 10 : 3)) return;
      dr.active = true;
    }
    const L = this.layout;
    const n = dr.name;
    if (n === "TL") {
      const ch = this.trig && this.trig.ch;
      if (!ch) return;
      const divH = L.h / DIVY;
      const v = ((L.y + L.h / 2 - py) / divH - ch.pos) * ch.vdiv;
      if (this.onTrigLevel) this.onTrigLevel(v);
      return;
    }
    if (n === "TP") {
      if (this.onTrigPos) this.onTrigPos(Math.min(Math.max((px - L.x) / L.w, 0.05), 0.95));
      return;
    }
    const frac = n[0] === "X" ? (px - L.x) / L.w : (py - L.y) / L.h;
    if (this.onCursor) this.onCursor(n, Math.min(Math.max(frac, 0), 1));
  }
}
