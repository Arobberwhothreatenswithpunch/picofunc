import { connect, availableMethods, isAndroid } from "./transport.js";
import { calcPwm, calcWave, fmtHz, niceCeil } from "./sim.js";
import { Scope } from "./scope.js";
import { createInverter } from "./inverter.js";
import { buildChannels, COLORS } from "./signals.js";
import { MEAS_TYPES, MEAS_N, FFT_N, WINDOWS, record, measure, spectrum, peaks } from "./measure.js";
import { createSoftkeys } from "./menus.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const UNITS = { Hz: 1, kHz: 1e3, MHz: 1e6 };
const DEBOUNCE_MS = 120;
const MAX_MEAS = 8;

// ---------------------------------------------------------------------
// state (UI の設定値は端末ごとに localStorage へ保存)
// ---------------------------------------------------------------------
const DEFAULT = {
  pwm: { f: 1000, duty: 50 },
  wave: { type: "SINE", f: 1000, amp: 100, ofs: 50 },
  sim: { mode: "rc", R: 1000, CnF: 10 },
  method: "auto",
  scope: {
    mode: "gen", panel: "gen1", menu: "meas", run: true,
    on: { gen: { 1: true, 2: true, 3: false, 4: false }, inv: { 1: true, 2: true, 3: true, M: true } },
    trig: { gen: { src: "1", slope: "rise", auto: true, level: 1.65 },
            inv: { src: "1", slope: "rise", auto: true, level: 1.65 } },
    meas: { gen: [{ t: "freq", s: "1" }, { t: "duty", s: "1" }, { t: "freq", s: "2" }, { t: "vpp", s: "2" }],
            inv: [{ t: "freq", s: "1" }, { t: "phase", s: "1", s2: "2" }, { t: "vrms", s: "M" }, { t: "vpp", s: "M" }] },
    msel: { t: "freq", s: "1", s2: "2" },
    stats: false,
    cur: { mode: "off", src: "1", x1: 0.35, x2: 0.65, y1: 0.3, y2: 0.6 },
    fft: { on: false, src: "1", win: "hann", span: 1, peaks: true },
    invView: "avg", mAll: false, ch1b: false,
  },
};
const STORE_KEY = "fgen-ui-v1";
const isObj = (o) => o && typeof o === "object" && !Array.isArray(o);
function merge(def, saved) {
  if (!isObj(def) || !isObj(saved)) return saved === undefined ? structuredClone(def) : saved;
  const out = {};
  for (const k of new Set([...Object.keys(def), ...Object.keys(saved)])) {
    out[k] = k in saved ? (isObj(def[k]) ? merge(def[k], saved[k]) : saved[k]) : structuredClone(def[k]);
  }
  return out;
}
let S = structuredClone(DEFAULT);
try { S = merge(DEFAULT, JSON.parse(localStorage.getItem(STORE_KEY) || "{}")); } catch {}
delete S.view;
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} };
const SC = () => S.scope;

const out = { pwm: false, wave: false };   // デバイス側の出力状態 (応答で更新)
let link = null;                            // transport
let wakeLock = null;
let raf = 0, rafCompute = false;

// ---------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------
const SI = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
function fmtSI(v, unit, digits = 4) {
  if (!isFinite(v)) return "----";
  if (v === 0) return `0${unit}`;
  const a = Math.abs(v);
  for (const [s, p] of SI) if (a >= s * 0.99995) return `${(v / s).toPrecision(digits)}${p}${unit}`;
  return `${v.toExponential(2)}${unit}`;
}
function fmtMeas(t, v) {
  if (!isFinite(v)) return "----";
  const u = MEAS_TYPES[t].unit;
  if (u === "%") return `${v.toFixed(2)}%`;
  if (u === "°") return `${v.toFixed(1)}°`;
  return fmtSI(v, u);
}

// ---------------------------------------------------------------------
// controls (Gen1 / Gen2)
// ---------------------------------------------------------------------
const FREQ_CFG = {
  pwm: { min: 0.1, max: 10e6, chips: [1, 1e3, 1e4, 1e5, 1e6, 1e7] },
  wave: { min: 1, max: 24e3, chips: [10, 100, 1e3, 5e3, 2e4] },
};
const chipLabel = (f) => fmtHz(f).replace(" ", "");
const autoUnit = (f) => (f >= 1e6 ? "MHz" : f >= 1e3 ? "kHz" : "Hz");
const tidy = (f) => Number(f.toPrecision(3));
const setters = {};   // ソフトキーから値を変えるための入口

function buildFreq(el) {
  const ch = el.dataset.ch, cfg = FREQ_CFG[ch];
  el.append($("#tpl-freq").content.cloneNode(true));
  const num = $(".num", el), unit = $(".unit-sel", el), range = $(".range", el);
  const lmin = Math.log10(cfg.min), lmax = Math.log10(cfg.max);

  const show = () => {
    const f = S[ch].f;
    num.value = Number((f / UNITS[unit.value]).toPrecision(7));
    range.value = Math.round((Math.log10(Math.min(Math.max(f, cfg.min), cfg.max)) - lmin) / (lmax - lmin) * 1000);
  };
  const set = (f, keepUnit = false) => {
    if (!(f > 0)) return show();
    S[ch].f = f;
    if (!keepUnit) unit.value = autoUnit(f);
    show();
    changed(ch);
  };
  range.addEventListener("input", () => set(tidy(10 ** (lmin + range.value / 1000 * (lmax - lmin)))));
  num.addEventListener("change", () => set(parseFloat(num.value) * UNITS[unit.value], true));
  unit.addEventListener("change", show);
  for (const f of cfg.chips) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = chipLabel(f);
    b.addEventListener("click", () => set(f));
    $(".chips", el).append(b);
  }
  unit.value = autoUnit(S[ch].f);
  show();
  setters[`${ch}.f`] = set;
}

function buildPct(el) {
  const { ch, key, label, step } = el.dataset;
  el.append($("#tpl-pct").content.cloneNode(true));
  const num = $(".num", el), range = $(".range", el);
  $(".name", el).textContent = label;
  num.step = step; range.step = step;
  const show = () => { num.value = S[ch][key]; range.value = S[ch][key]; };
  const set = (v) => {
    if (!isFinite(v)) return show();
    S[ch][key] = Math.min(Math.max(Number(v.toFixed(3)), 0), 100);
    show();
    changed(ch);
  };
  range.addEventListener("input", () => set(parseFloat(range.value)));
  num.addEventListener("change", () => set(parseFloat(num.value)));
  for (const v of el.dataset.chips.split(",")) {
    const b = document.createElement("button");
    b.className = "chip"; b.textContent = `${v}%`;
    b.addEventListener("click", () => set(Number(v)));
    $(".chips", el).append(b);
  }
  show();
  setters[`${ch}.${key}`] = set;
}

$$(".freq").forEach(buildFreq);
$$(".pct").forEach(buildPct);

const typeBtns = $$("#wave-type button");
const showType = () => typeBtns.forEach((b) => b.classList.toggle("sel", b.dataset.v === S.wave.type));
const setType = (v) => { S.wave.type = v; showType(); changed("wave"); };
typeBtns.forEach((b) => b.addEventListener("click", () => setType(b.dataset.v)));
showType();

for (const ch of ["pwm", "wave"]) {
  $(`#${ch}-on`).addEventListener("change", (e) => {
    out[ch] = e.target.checked;   // 応答が来るまでの仮の状態
    apply(ch, true);
  });
}
function toggleOutput(ch) {
  const sw = $(`#${ch}-on`);
  if (sw.disabled) return toast("先に接続してください", true);
  sw.checked = !sw.checked;
  sw.dispatchEvent(new Event("change"));
}

// ---------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------
const pending = {};
function changed(ch) {
  save();
  redraw();
  clearTimeout(pending[ch]);
  pending[ch] = setTimeout(() => apply(ch, false), DEBOUNCE_MS);
}

function apply(ch, fromSwitch) {
  clearTimeout(pending[ch]);
  if (!link) return;
  const on = $(`#${ch}-on`).checked;
  if (ch === "pwm") {
    if (on) send(`PWM ${+S.pwm.f.toPrecision(7)} ${+S.pwm.duty.toFixed(4)}`);
    else if (fromSwitch) send("PWM OFF");
  } else {
    if (on) send(`WAVE ${S.wave.type} ${+S.wave.f.toPrecision(7)} ${S.wave.amp} ${S.wave.ofs}`);
    else if (fromSwitch) send("WAVE OFF");
  }
  redraw();
}

function send(cmd) {
  if (!link) return;
  if (cmd !== "INV STATUS") log(cmd, "tx");     // 定期ポーリングはログに出さない
  link.write(cmd + "\n");
}

function kv(line) {
  const o = {};
  for (const t of line.split(/\s+/)) {
    const i = t.indexOf("=");
    if (i > 0) o[t.slice(0, i)] = t.slice(i + 1);
  }
  return o;
}

let lastInvLog = "";
function handleLine(line) {
  if (line.startsWith("OK INV") || line.startsWith("AUD ")) {
    // ポーリング応答は状態が変わったときだけログに残す
    const st = line.startsWith("OK INV") ? (line.match(/state=(\S+)/) || [])[1] : null;
    if (st && st !== lastInvLog) { log(line, "rx"); lastInvLog = st; }
  } else {
    log(line, line.startsWith("ERR") ? "er" : "rx");
  }
  if (inv.handleLine(line)) return;
  const k = kv(line);
  try {
    if (line.startsWith("OK PWM")) {
      const on = !/ OFF\b/.test(line);
      out.pwm = on;
      $("#pwm-on").checked = on;
      let t = "停止中";
      if (on) {
        t = `${fmtHz(parseFloat(k.f))} / ${parseFloat(k.duty).toFixed(3)}% [${k.mode}`;
        if (k.mode === "HW") t += ` ${k.steps}段`;
        t += "]" + (k.clamped === "1" ? " ※範囲制限" : "");
      }
      setInfo("pwm", t, on);
    } else if (line.startsWith("OK WAVE")) {
      const on = !/ OFF\b/.test(line);
      out.wave = on;
      $("#wave-on").checked = on;
      const t = on ? `${fmtHz(parseFloat(k.f))} [${k.n}点, 更新 ${fmtHz(parseFloat(k.fs))}]` +
                     (k.clamped === "1" ? " ※範囲制限" : "") : "停止中";
      setInfo("wave", t, on);
    } else if (line.startsWith("OK ID")) {
      setStatus(true, line.slice(6).split(" sys=")[0]);
      inv.setSupported(k.inv === "1");
    } else if (line.startsWith("ERR")) {
      toast(line, true);
    }
  } catch (e) {
    log(`応答を解析できません: ${e}`, "er");
  }
  redraw();
}

function setInfo(ch, text, active) {
  const el = $(`#${ch}-info`);
  el.textContent = text;
  el.classList.toggle("active", active);
}

// ---------------------------------------------------------------------
// connection
// ---------------------------------------------------------------------
const method = $("#method");
method.value = S.method;
method.addEventListener("change", () => { S.method = method.value; save(); });
{
  const av = availableMethods();
  $("#support").textContent =
    `対応: Web Serial ${av.serial ? "○" : "×"} / WebUSB ${av.usb ? "○" : "×"}${isAndroid ? " (Android)" : ""}`;
}

$("#connect").addEventListener("click", async () => {
  if (link) return disconnect();
  try {
    link = await connect(S.method);
  } catch (e) {
    link = null;
    if (e && e.name === "NotFoundError") return;          // 選択キャンセル
    toast(`接続できません: ${e.message || e}`, true);
    log(String(e), "er");
    return;
  }
  link.onLine = handleLine;
  link.onClose = (e) => {
    log(`切断: ${e && e.message ? e.message : e}`, "er");
    disconnect(false);
  };
  setStatus(true, link.kind);
  $("#connect").textContent = "切断";
  $("#connect").classList.remove("primary");
  $$(".switch input").forEach((s) => (s.disabled = false));
  log(`接続 (${link.kind})`, "rx");
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  inv.onConnect();
  send("ID");
  send("STATUS");
  redraw();
});

async function disconnect(closeLink = true) {
  const l = link;
  link = null;
  if (l && closeLink) await l.close();
  out.pwm = out.wave = false;
  $$(".switch input").forEach((s) => { s.checked = false; s.disabled = true; });
  setInfo("pwm", "未接続", false);
  setInfo("wave", "未接続", false);
  setStatus(false);
  inv.onDisconnect();
  $("#connect").textContent = "接続";
  $("#connect").classList.add("primary");
  try { await wakeLock?.release(); } catch {}
  wakeLock = null;
  redraw();
}

function setStatus(on, text) {
  const st = $("#status");
  st.classList.toggle("on", on);
  st.textContent = on ? text : "未接続";
}

// ---------------------------------------------------------------------
// scope: 計算 (compute) と描画 (render)
// ---------------------------------------------------------------------
const scope = new Scope($("#scope"));
const inv = createInverter($("#inv-card"), {
  send,
  sendBytes: (b) => link && link.writeBytes(b),
  connected: () => !!link,
  toast,
  redraw,
});

let frame = null;
const stats = new Map();
const rcValue = () => { const rc = (S.sim.R || 0) * (S.sim.CnF || 0) * 1e-9; return rc > 0 ? rc : 0; };

// トリガ点 (画面中央) を探す。見つからなければ null (Auto = 自由走行)
function findTrigger(ch, L, slope, tw, P) {
  const rise = slope !== "fall";
  // 刻みはキャリア等と同期しないよう無理数比にする (同期するとストロボ的に同じ位相ばかり見てしまう)
  const start = tw / 2, len = P ? 2.2 * P : tw, step = ((P || tw) / 400) * 0.6180339887;
  for (let t = start; t < start + len; t += step) {
    const v0 = ch.v(t);
    if (rise ? v0 >= L : v0 <= L) continue;
    const [lo, hi] = ch.span(t, t + step);
    if (rise ? hi < L : lo > L) continue;
    let a = t, b = t + step;
    for (let i = 0; i < 40; i++) {
      const m = (a + b) / 2;
      const [l2, h2] = ch.span(a, m);
      if (rise ? h2 >= L : l2 <= L) b = m; else a = m;
    }
    return b;
  }
  return null;
}

function midLevel(ch, P, tw) {
  const span = P || tw;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i <= 1000; i++) {
    const v = ch.v((2 * span * i) / 1000);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return (lo + hi) / 2;
}

function compute() {
  const sc = SC(), mode = sc.mode;
  const st = mode === "gen"
    ? { mode, pwm: calcPwm(S.pwm.f, S.pwm.duty), wave: calcWave(S.wave.type, S.wave.f, S.wave.amp, S.wave.ofs),
        showB: sc.ch1b, probe: S.sim.mode, rc: rcValue(), active: { pwm: !!link && out.pwm, wave: !!link && out.wave } }
    : { mode, inv: inv.simState(), invView: sc.invView, mAll: sc.mAll };
  const b = buildChannels(st);
  const byId = Object.fromEntries(b.channels.map((c) => [c.id, c]));
  const on = sc.on[mode];
  const tr = sc.trig[mode];
  const tch = byId[tr.src] || b.channels[0];
  const P = tch.period > 0 && isFinite(tch.period) ? tch.period : null;
  const tdiv = P ? niceCeil((3 * P) / 10) : b.defaultTdiv;
  const tw = tdiv * 10;
  const autoLevel = midLevel(tch, P, tw);
  const level = tr.auto ? autoLevel : tr.level;
  const tc = findTrigger(tch, level, tr.slope, tw, P);
  const t0 = tc === null ? 0 : tc - tw / 2;

  const recs = new Map();
  const rec = (id) => {
    if (!byId[id]) return null;
    if (!recs.has(id)) recs.set(id, record(byId[id], t0, tw, MEAS_N));
    return recs.get(id);
  };
  const meas = sc.meas[mode].map((m) => {
    const r = rec(m.s);
    const v = r ? measure(m.t, r, m.t === "phase" ? rec(m.s2) : null) : NaN;
    const key = `${mode}|${m.t}|${m.s}|${m.s2 || ""}`;
    if (sc.stats && isFinite(v)) {
      const s = stats.get(key) || { n: 0, sum: 0, min: Infinity, max: -Infinity };
      s.n++; s.sum += v; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v);
      stats.set(key, s);
    }
    return { ...m, v, key };
  });

  let fft = null;
  const fs = sc.fft;
  if (fs.on && byId[fs.src]) {
    const sp = spectrum(record(byId[fs.src], t0, tw, FFT_N, 4), fs.win);
    const fmax = sp.fmax * fs.span;
    let mx = -Infinity;
    for (let k = 0; k < sp.db.length && k * sp.df <= fmax; k++) if (sp.db[k] > mx) mx = sp.db[k];
    const refDb = Math.ceil((mx + 3) / 10) * 10;
    fft = { sp, fmax, refDb, src: fs.src, winLabel: WINDOWS[fs.win].label,
            peaks: fs.peaks ? peaks(sp, 5, fmax, refDb - 80) : [] };
  }

  frame = { mode, all: b.channels, byId, channels: b.channels.filter((c) => on[c.id]),
            t0, tw, tdiv, trig: { ch: tch, level, autoLevel, status: tc === null ? "Auto" : "Trig'd", slope: tr.slope },
            fft, note: b.note, phasor: b.phasor, meas };
}

function redraw() { schedule(true); }
function rerender() { schedule(false); }
function schedule(full) {
  rafCompute = rafCompute || full;
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if ((rafCompute && SC().run) || !frame) compute();
    rafCompute = false;
    render();
  });
}

function render() {
  if (!frame) return;
  const sc = SC();
  scope.draw({ ...frame, cursors: sc.cur });
  $("#scope").style.touchAction = sc.cur.mode === "off" ? "pan-y" : "none";
  renderStatus();
  renderSidebar();
  renderKeys();
  softkeys.refresh();
}

function renderStatus() {
  const sc = SC(), f = frame;
  const h = [];
  const modeLabel = f.mode === "gen" ? "信号源" : `INV ${inv.simState().mode}`;
  h.push(`<div class="sb"><span class="lbl">${modeLabel}</span></div>`);
  for (const ch of f.all) {
    if (!sc.on[f.mode][ch.id]) continue;
    h.push(`<div class="sb"><span class="tag" style="background:${ch.color}">${ch.id}</span>${ch.label} ${fmtSI(ch.vdiv, "V/", 3)}</div>`);
  }
  h.push(`<div class="sb grow"></div>`);
  h.push(`<div class="sb"><span class="lbl">H</span>${fmtSI(f.tdiv, "s/", 4)}</div>`);
  h.push(`<div class="sb"><span class="lbl">▼</span>0.000s</div>`);
  const tc = f.trig.ch;
  h.push(`<div class="sb"><span class="lbl">${f.trig.status}</span><span class="tag" style="background:${tc.color}">${tc.id}</span>${f.trig.slope === "fall" ? "↓" : "↑"} ${fmtSI(f.trig.level, "V", 3)}</div>`);
  h.push(`<div class="sb ${sc.run ? "run" : "stop"}">${sc.run ? "Run" : "Stop"}</div>`);
  $("#statusbar").innerHTML = h.join("");
}

function renderSidebar() {
  const sc = SC(), f = frame;
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const tagOf = (id) => `<span class="m-tag" style="background:${COLORS[id]}">${id}</span>`;
  const h = [];
  h.push(`<div class="sb-sec"><div class="sb-h">測定</div><div class="m-list">`);
  if (!f.meas.length) h.push(`<div class="m-name">測定キー → 追加</div>`);
  for (const m of f.meas) {
    const name = MEAS_TYPES[m.t].label + (m.t === "phase" ? ` ${m.s}→${m.s2}` : "");
    h.push(`<div class="m-row">${tagOf(m.s)}<span class="m-name">${esc(name)}</span><span class="m-val">${fmtMeas(m.t, m.v)}</span>`);
    const s = stats.get(m.key);
    if (sc.stats && s) h.push(`<span class="m-stat">μ ${fmtMeas(m.t, s.sum / s.n)}  ↓${fmtMeas(m.t, s.min)} ↑${fmtMeas(m.t, s.max)} n=${s.n}</span>`);
    h.push(`</div>`);
  }
  h.push(`</div></div>`);

  const cu = sc.cur;
  if (cu.mode !== "off") {
    const rows = [];
    if (cu.mode === "x" || cu.mode === "xy") {
      const t1 = (cu.x1 - 0.5) * f.tw, t2 = (cu.x2 - 0.5) * f.tw, dt = t2 - t1;
      rows.push(["X1", fmtSI(t1, "s")], ["X2", fmtSI(t2, "s")], ["ΔX", fmtSI(dt, "s")], ["1/ΔX", dt ? fmtSI(1 / Math.abs(dt), "Hz") : "----"]);
    }
    if (cu.mode === "y" || cu.mode === "xy") {
      const ch = f.byId[cu.src] || f.all[0];
      const yv = (fr) => ((0.5 - fr) * 8 - ch.pos) * ch.vdiv;
      const v1 = yv(cu.y1), v2 = yv(cu.y2);
      rows.push([`Y1(${ch.id})`, fmtSI(v1, "V")], ["Y2", fmtSI(v2, "V")], ["ΔY", fmtSI(v2 - v1, "V")]);
    }
    h.push(`<div class="sb-sec"><div class="sb-h">カーソル</div><div class="m-list">`);
    for (const [k, v] of rows) h.push(`<div class="c-row"><span>${k}</span><span>${v}</span></div>`);
    h.push(`</div></div>`);
  }
  if (f.fft && f.fft.peaks.length) {
    h.push(`<div class="sb-sec"><div class="sb-h">FFT ピーク (${f.fft.src})</div><div class="m-list">`);
    f.fft.peaks.forEach((p, i) => h.push(`<div class="c-row"><span>${i + 1}</span><span>${fmtSI(p.f, "Hz")} ${p.db.toFixed(1)}dBV</span></div>`));
    h.push(`</div></div>`);
  }
  $("#sidebar").innerHTML = h.join("");
}

// ---------------------------------------------------------------------
// front panel
// ---------------------------------------------------------------------
const softkeys = createSoftkeys($("#softkeys"), $("#popup"));

function chExists(id) { return !!(frame && frame.byId[id]); }

function renderKeys() {
  const sc = SC();
  for (const k of $$("#front .key")) {
    const key = k.dataset.key;
    let lit = false, dis = false;
    if (key === "run") { lit = true; k.classList.toggle("stopped", !sc.run); k.textContent = sc.run ? "Run" : "Stop"; }
    else if (key === "ch") { const id = k.dataset.ch; dis = !chExists(id); lit = !dis && !!sc.on[sc.mode][id]; }
    else if (key === "fft") lit = sc.fft.on;
    else if (key === "cursor") lit = sc.cur.mode !== "off";
    else if (["meas", "trig", "disp", "util"].includes(key)) lit = sc.menu === key;
    else if (key.startsWith("gen") || key === "inv") lit = sc.panel === key;
    k.classList.toggle("lit", lit);
    k.disabled = dis;
  }
  for (const p of $$("[data-panel]")) p.hidden = p.dataset.panel !== sc.panel;
}

function pressKey(key, id) {
  const sc = SC();
  switch (key) {
    case "run": sc.run = !sc.run; break;
    case "auto": autoScale(); break;
    case "ch": {
      const on = sc.on[sc.mode];
      if (!on[id]) { on[id] = true; sc.menu = `ch${id}`; }
      else if (sc.menu === `ch${id}`) on[id] = false;
      else sc.menu = `ch${id}`;
      break;
    }
    case "fft":
      if (!sc.fft.on) sc.fft.on = true;
      else if (sc.menu === "fft") sc.fft.on = false;
      sc.menu = "fft";
      break;
    case "cursor":
      if (sc.cur.mode === "off") sc.cur.mode = "x";
      sc.menu = "cursor";
      break;
    case "util": sc.menu = "util"; sc.panel = "util"; break;
    case "gen1": case "gen2": sc.mode = "gen"; sc.panel = key; sc.menu = key; break;
    case "inv": sc.mode = "inv"; sc.panel = "inv"; sc.menu = "inv"; break;
    default: sc.menu = key;
  }
  save();
  setMenu();
  redraw();
}
$$("#front .key").forEach((k) => k.addEventListener("click", () => pressKey(k.dataset.key, k.dataset.ch)));

function autoScale() {
  const sc = SC();
  if (sc.mode === "gen") sc.on.gen = { 1: true, 2: true, 3: false, 4: false };
  else sc.on.inv = { 1: true, 2: true, 3: true, M: true };
  sc.trig[sc.mode] = { ...sc.trig[sc.mode], src: "1", slope: "rise", auto: true };
  sc.run = true;
  toast("Auto Scale");
}

// ---------------------------------------------------------------------
// softkey menus
// ---------------------------------------------------------------------
const toggleItem = (label, get, set, color) =>
  ({ label, value: () => (get() ? "ON" : "OFF"), onClick: () => { set(!get()); save(); redraw(); }, lit: get, color });
const srcOpts = () => (frame ? frame.all : []).map((c) => ({ v: c.id, label: `${c.id}: ${c.label}`, short: `${c.id} ${c.label}`, color: c.color }));
const viewItem = () => ({
  label: "インバータ表示",
  options: () => [{ v: "avg", label: "平均 (RC 後)" }, { v: "sw", label: "スイッチング波形" }],
  get: () => SC().invView, set: (v) => { SC().invView = v; save(); redraw(); },
});
const probeItem = () => ({
  label: "プローブ",
  options: () => [{ v: "rc", label: "RC フィルタ後" }, { v: "ideal", label: "理想 (PWM 平均)" }],
  get: () => S.sim.mode, set: (v) => { S.sim.mode = v; save(); redraw(); },
});
const invBtn = (cls) => $(`#inv-card .${cls}`);
const invProxy = (label, cls) => ({ label, onClick: () => invBtn(cls).click(), disabled: () => invBtn(cls).disabled });

function menuFor(name) {
  const sc = SC(), mode = sc.mode;
  if (name.startsWith("ch")) {
    const id = name.slice(2);
    const on = sc.on[mode];
    const items = [toggleItem("表示", () => !!on[id], (v) => (on[id] = v), COLORS[id])];
    if (mode === "gen") {
      if (id === "1") items.push(toggleItem("GP1 反転表示", () => sc.ch1b, (v) => (sc.ch1b = v)));
      else items.push(probeItem(),
        { label: "R", num: { get: () => S.sim.R, set: (v) => { S.sim.R = v; save(); redraw(); }, step: 100, unit: "Ω", min: 1 } },
        { label: "C", num: { get: () => S.sim.CnF, set: (v) => { S.sim.CnF = v; save(); redraw(); }, step: 1, unit: "nF", min: 0.001 } });
    } else {
      items.push(viewItem());
      if (id === "M") items.push(toggleItem("線間 3 本", () => sc.mAll, (v) => (sc.mAll = v)));
    }
    const ch = frame && frame.byId[id];
    return [`CH ${id}${ch ? " " + ch.label : ""}`, items];
  }
  switch (name) {
    case "meas": {
      const list = () => sc.meas[mode];
      return ["測定", [
        { label: "ソース", options: srcOpts, get: () => sc.msel.s, set: (v) => { sc.msel.s = v; save(); } },
        { label: "種類", options: () => Object.entries(MEAS_TYPES).map(([v, o]) => ({ v, label: o.label })),
          get: () => sc.msel.t, set: (v) => { sc.msel.t = v; save(); setMenu(); } },
        sc.msel.t === "phase"
          ? { label: "ソース 2", options: srcOpts, get: () => sc.msel.s2, set: (v) => { sc.msel.s2 = v; save(); } }
          : toggleItem("統計", () => sc.stats, (v) => { sc.stats = v; stats.clear(); }),
        { label: "追加", value: () => `${list().length}/${MAX_MEAS}`, disabled: () => list().length >= MAX_MEAS,
          onClick: () => { list().push({ ...sc.msel }); save(); redraw(); } },
        { label: "最後を削除", disabled: () => !list().length, onClick: () => { list().pop(); save(); redraw(); } },
        { label: "全消去", disabled: () => !list().length, onClick: () => { list().length = 0; save(); redraw(); } },
      ]];
    }
    case "cursor":
      return ["カーソル", [
        { label: "モード", options: () => [{ v: "off", label: "Off" }, { v: "x", label: "X (時間)" }, { v: "y", label: "Y (電圧)" }, { v: "xy", label: "X + Y" }],
          get: () => sc.cur.mode, set: (v) => { sc.cur.mode = v; save(); rerender(); } },
        { label: "Y ソース", options: srcOpts, get: () => sc.cur.src, set: (v) => { sc.cur.src = v; save(); rerender(); } },
        { label: "位置リセット", onClick: () => { Object.assign(sc.cur, { x1: 0.35, x2: 0.65, y1: 0.3, y2: 0.6 }); save(); rerender(); } },
        { label: "操作", value: () => "画面をドラッグ", onClick: () => toast("画面上をドラッグすると、近いカーソルが動きます"), disabled: () => sc.cur.mode === "off" },
      ]];
    case "fft":
      return ["FFT", [
        toggleItem("FFT", () => sc.fft.on, (v) => (sc.fft.on = v), COLORS.M),
        { label: "ソース", options: srcOpts, get: () => sc.fft.src, set: (v) => { sc.fft.src = v; save(); redraw(); } },
        { label: "窓関数", options: () => Object.entries(WINDOWS).map(([v, o]) => ({ v, label: o.label })),
          get: () => sc.fft.win, set: (v) => { sc.fft.win = v; save(); redraw(); } },
        { label: "スパン", options: () => [1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01].map((v) => ({ v, label: v === 1 ? "全域 (fs/2)" : `1/${Math.round(1 / v)}` })),
          get: () => sc.fft.span, set: (v) => { sc.fft.span = v; save(); redraw(); } },
        toggleItem("ピーク", () => sc.fft.peaks, (v) => (sc.fft.peaks = v)),
        { label: "レコード", value: () => `${FFT_N / 1024}k点`, onClick: () => toast(`FFT は画面区間を ${FFT_N} 点でサンプリングして計算します`) },
      ]];
    case "trig": {
      const tr = () => sc.trig[mode];
      return ["トリガ", [
        { label: "ソース", options: srcOpts, get: () => tr().src, set: (v) => { tr().src = v; save(); redraw(); } },
        { label: "スロープ", options: () => [{ v: "rise", label: "↑ 立上り" }, { v: "fall", label: "↓ 立下り" }],
          get: () => tr().slope, set: (v) => { tr().slope = v; save(); redraw(); } },
        { label: "レベル", options: () => [{ v: true, label: "自動 (50%)" }, { v: false, label: "手動" }],
          get: () => tr().auto, set: (v) => { tr().auto = v; if (!v && frame) tr().level = +frame.trig.level.toFixed(3); save(); redraw(); } },
        { label: "レベル値", num: { get: () => +(frame ? frame.trig.level : tr().level).toFixed(3),
          set: (v) => { tr().level = v; tr().auto = false; save(); redraw(); }, step: 0.1, unit: "V" } },
        { label: "50% に設定", onClick: () => { if (frame) tr().level = +frame.trig.autoLevel.toFixed(3); tr().auto = false; save(); redraw(); } },
      ]];
    }
    case "disp":
      return ["表示", [
        viewItem(),
        toggleItem("線間 3 本", () => sc.mAll, (v) => (sc.mAll = v)),
        toggleItem("GP1 反転", () => sc.ch1b, (v) => (sc.ch1b = v)),
        toggleItem("測定統計", () => sc.stats, (v) => { sc.stats = v; stats.clear(); }),
        { label: "統計リセット", onClick: () => { stats.clear(); redraw(); } },
      ]];
    case "util":
      return ["Utility", [
        { label: "接続方式", options: () => [{ v: "auto", label: "自動" }, { v: "serial", label: "Web Serial (PC)" }, { v: "usb", label: "WebUSB (Android)" }],
          get: () => S.method, set: (v) => { S.method = v; method.value = v; save(); } },
        { label: "接続", value: () => (link ? "切断する" : "接続する"), onClick: () => $("#connect").click() },
        { label: "ログ消去", onClick: () => { $("#log").innerHTML = ""; } },
      ]];
    case "gen1":
      return ["Gen1 PWM", [
        { label: "出力", value: () => ($("#pwm-on").checked ? "ON" : "OFF"), lit: () => $("#pwm-on").checked,
          onClick: () => toggleOutput("pwm"), disabled: () => !link, color: COLORS[1] },
        { label: "周波数", options: () => [1, 10, 100, 1e3, 1e4, 1e5, 1e6, 1e7].map((v) => ({ v, label: fmtHz(v) })),
          get: () => S.pwm.f, set: (v) => setters["pwm.f"](v) },
        { label: "デューティ", options: () => [1, 10, 25, 50, 75, 90, 99].map((v) => ({ v, label: `${v}%` })),
          get: () => S.pwm.duty, set: (v) => setters["pwm.duty"](v) },
        toggleItem("GP1 反転表示", () => sc.ch1b, (v) => (sc.ch1b = v)),
      ]];
    case "gen2":
      return ["Gen2 波形", [
        { label: "出力", value: () => ($("#wave-on").checked ? "ON" : "OFF"), lit: () => $("#wave-on").checked,
          onClick: () => toggleOutput("wave"), disabled: () => !link, color: COLORS[2] },
        { label: "波形", options: () => [["SINE", "正弦"], ["TRI", "三角"], ["SAW", "のこぎり"], ["SQR", "矩形"]].map(([v, label]) => ({ v, label })),
          get: () => S.wave.type, set: setType },
        { label: "周波数", options: () => [10, 100, 1e3, 5e3, 1e4, 2e4].map((v) => ({ v, label: fmtHz(v) })),
          get: () => S.wave.f, set: (v) => setters["wave.f"](v) },
        { label: "振幅", options: () => [25, 50, 75, 100].map((v) => ({ v, label: `${v}%` })),
          get: () => S.wave.amp, set: (v) => setters["wave.amp"](v) },
        probeItem(),
      ]];
    case "inv":
      return ["Inverter", [
        invProxy("有効化", "inv-enable"),
        invProxy("無効化", "inv-disable"),
        invProxy("運転", "inv-run"),
        invProxy("停止 (m→0)", "inv-stop"),
        viewItem(),
        { label: "相数", value: () => inv.simState().mode,
          onClick: () => { const m = inv.simState().mode === "3P" ? "1P" : "3P"; $(`#inv-card .inv-mode button[data-v="${m}"]`).click(); },
          disabled: () => $("#inv-card .inv-mode button").disabled },
      ]];
  }
  return ["", []];
}

function setMenu() {
  const [title, items] = menuFor(SC().menu);
  softkeys.set(title, items);
}

scope.onCursor = (name, frac) => {
  SC().cur[name.toLowerCase()] = frac;
  save();
  rerender();
};

new ResizeObserver(rerender).observe($(".screen"));
compute();
setMenu();
render();

// ---------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------
function log(text, cls) {
  const el = $("#log");
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = (cls === "tx" ? "> " : cls === "rx" ? "< " : "! ") + text;
  el.append(d);
  while (el.childElementCount > 300) el.firstElementChild.remove();
  el.scrollTop = el.scrollHeight;
}

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("err", err);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 3500);
}

document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && link && (!wakeLock || wakeLock.released)) {
    try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  }
});

if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
