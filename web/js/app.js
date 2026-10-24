import { connect, availableMethods, isAndroid } from "./transport.js";
import { calcPwm, calcWave, fmtHz } from "./sim.js";
import { Scope } from "./scope.js";
import { createInverter } from "./inverter.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const UNITS = { Hz: 1, kHz: 1e3, MHz: 1e6 };
const DEBOUNCE_MS = 120;

// ---------------------------------------------------------------------
// state (UI の設定値は端末ごとに localStorage へ保存)
// ---------------------------------------------------------------------
const DEFAULT = {
  pwm: { f: 1000, duty: 50 },
  wave: { type: "SINE", f: 1000, amp: 100, ofs: 50 },
  sim: { mode: "rc", R: 1000, CnF: 10, show: { b: false, p: true, n: true, diff: true } },
  method: "auto",
  view: "gen",
};
const STORE_KEY = "fgen-ui-v1";
let S = structuredClone(DEFAULT);
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
  if (saved) S = { ...S, ...saved, pwm: { ...S.pwm, ...saved.pwm }, wave: { ...S.wave, ...saved.wave },
                   sim: { ...S.sim, ...saved.sim, show: { ...S.sim.show, ...(saved.sim || {}).show } } };
} catch {}
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} };

const out = { pwm: false, wave: false };   // デバイス側の出力状態 (応答で更新)
let link = null;                            // transport
let wakeLock = null;

// ---------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------
const FREQ_CFG = {
  pwm: { min: 0.1, max: 10e6, chips: [1, 1e3, 1e4, 1e5, 1e6, 1e7] },
  wave: { min: 1, max: 24e3, chips: [10, 100, 1e3, 5e3, 2e4] },
};
const chipLabel = (f) => fmtHz(f).replace(" ", "");
const autoUnit = (f) => (f >= 1e6 ? "MHz" : f >= 1e3 ? "kHz" : "Hz");
const tidy = (f) => Number(f.toPrecision(3));

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
}

$$(".freq").forEach(buildFreq);
$$(".pct").forEach(buildPct);

// wave type
const typeBtns = $$("#wave-type button");
const showType = () => typeBtns.forEach((b) => b.classList.toggle("sel", b.dataset.v === S.wave.type));
typeBtns.forEach((b) => b.addEventListener("click", () => { S.wave.type = b.dataset.v; showType(); changed("wave"); }));
showType();

// simulation options (PC: スコープ下, スマホ: 折りたたみカード) — 同じ値を共有
$$(".sim-opts").forEach((box, i) => {
  box.append($("#tpl-sim").content.cloneNode(true));
  $$("input[name=simmode]", box).forEach((r) => {
    r.name = `simmode${i}`;
    r.addEventListener("change", () => { S.sim.mode = r.value; syncSim(); });
  });
  $(".sim-r", box).addEventListener("input", (e) => { S.sim.R = parseFloat(e.target.value); syncSim(); });
  $(".sim-c", box).addEventListener("input", (e) => { S.sim.CnF = parseFloat(e.target.value); syncSim(); });
  $$("[data-show]", box).forEach((c) =>
    c.addEventListener("change", () => { S.sim.show[c.dataset.show] = c.checked; syncSim(); }));
});
function syncSim(redrawOnly = false) {
  for (const box of $$(".sim-opts")) {
    $$("input[type=radio]", box).forEach((r) => (r.checked = r.value === S.sim.mode));
    for (const [cls, k] of [[".sim-r", "R"], [".sim-c", "CnF"]]) {
      const inp = $(cls, box);
      if (document.activeElement !== inp) inp.value = isFinite(S.sim[k]) ? S.sim[k] : "";
    }
    $$("[data-show]", box).forEach((c) => (c.checked = !!S.sim.show[c.dataset.show]));
  }
  if (!redrawOnly) save();
  redraw();
}

// output switches
for (const ch of ["pwm", "wave"]) {
  $(`#${ch}-on`).addEventListener("change", (e) => {
    out[ch] = e.target.checked;   // 応答が来るまでの仮の状態
    apply(ch, true);
  });
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
// scope
// ---------------------------------------------------------------------
const scope = new Scope($("#scope"));
let raf = 0;
function redraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (S.view === "inv") return scope.drawInverter(inv.simState());
    const rc = (S.sim.R || 0) * (S.sim.CnF || 0) * 1e-9;
    scope.draw({
      pwm: calcPwm(S.pwm.f, S.pwm.duty), pwmActive: !!link && out.pwm, showB: S.sim.show.b,
      wave: calcWave(S.wave.type, S.wave.f, S.wave.amp, S.wave.ofs), waveActive: !!link && out.wave,
      waveMode: S.sim.mode, rc: rc > 0 ? rc : 0, show: S.sim.show,
    });
  });
}
new ResizeObserver(redraw).observe($("#scope"));

const inv = createInverter($("#inv-card"), {
  send,
  sendBytes: (b) => link && link.writeBytes(b),
  connected: () => !!link,
  toast,
  redraw,
});

const tabs = $$(".tabs button");
const showView = () => {
  tabs.forEach((b) => b.classList.toggle("sel", b.dataset.view === S.view));
  $$(".sim-opts").forEach((e) => (e.style.visibility = S.view === "gen" ? "" : "hidden"));
  $(".controls").classList.toggle("inv-first", S.view === "inv");
  redraw();
};
tabs.forEach((b) => b.addEventListener("click", () => { S.view = b.dataset.view; save(); showView(); }));
// インバータのカードを触ったら自動でインバータ表示に切り替える
$("#inv-card").addEventListener("input", () => { if (S.view !== "inv") { S.view = "inv"; save(); showView(); } });
showView();
syncSim(true);

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
