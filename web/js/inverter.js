// インバータ (IR2302 ハーフブリッジ用スイッチング信号) の操作 UI
// ファームウェア側: src/inverter.cpp  (INV ... コマンド)
import { calcInverter, fmtHz, INV } from "./sim.js";

const STORE_KEY = "fgen-inv-v1";
const DEFAULT = {
  mode: "3P", fc: 20000, f: 50, m: 0.3, accel: 100, dir: "FWD",
  dcDeg: 0, dcM: 0.15, dcTo: 10, audM: 0.3, loop: false, vbus: 30,
};
const POLL_MS = 300;
const SEND_DEBOUNCE_MS = 120;
const AUD_FRAME = 1024;          // samples per binary frame
const AUD_TARGET_S = 0.3;        // keep this much audio buffered on the device

const $ = (s, el) => el.querySelector(s);

export function createInverter(root, api) {
  // api: { send(cmd), sendBytes(u8), connected(), toast(msg, err), redraw() }
  let S = { ...DEFAULT };
  try { S = { ...S, ...JSON.parse(localStorage.getItem(STORE_KEY) || "{}") }; } catch {}
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch {} };

  let dev = { state: "OFF" };    // last "OK INV ..." from the device
  let supported = true;
  let lastKind = "RUN";          // scope preview: RUN | DC | AUDIO
  const aud = { pcm: null, fs: 0, bw: 0, name: "", dur: 0, env: null, sent: 0, fill: 0, tFill: 0,
                under: 0, playing: false, timer: 0, converting: false };

  root.innerHTML = `
    <h2><span class="dot" style="background:var(--inv)"></span>インバータ
      <span class="tag">IR2302 · GP4 U / GP6 V / GP8 W · GP10 SD · GP11 非常停止</span></h2>
    <div class="inv-fault" hidden></div>
    <div class="inv-state"><span class="pill inv-pill">OFF</span><span class="info inv-info">未接続</span></div>
    <div class="seg two inv-mode"><button data-v="3P">3相 (リニア)</button><button data-v="1P">単相 (オーディオ)</button></div>
    <div class="ctl" data-k="fc"></div>
    <div class="inv-btns">
      <button class="btn big ok inv-enable">有効化</button>
      <button class="btn big danger inv-disable">無効化 (SD Low)</button>
    </div>

    <h3>正弦波運転</h3>
    <div class="ctl" data-k="f"></div>
    <div class="ctl" data-k="m"></div>
    <div class="row"><label class="name">加速度</label>
      <input type="number" class="inv-accel" min="0.1" max="100000" step="any"><span class="unit">Hz/s</span></div>
    <div class="row only3p"><label class="name">相順</label>
      <div class="seg two inv-dir"><button data-v="FWD">正転 UVW</button><button data-v="REV">逆転 UWV</button></div></div>
    <div class="inv-err"></div>
    <div class="inv-btns">
      <button class="btn inv-run">運転</button><button class="btn inv-stop">停止 (m→0)</button>
    </div>

    <div class="only3p">
      <h3>直流励磁 <span class="tag">位置合わせ・保持・微小送り</span></h3>
      <div class="ctl" data-k="dcDeg"></div>
      <div class="chips inv-jog">
        <button class="chip" data-d="-30">−30°</button><button class="chip" data-d="-5">−5°</button>
        <button class="chip" data-d="5">+5°</button><button class="chip" data-d="30">+30°</button>
        <button class="chip" data-a="0">0°</button><button class="chip" data-a="90">90°</button>
        <button class="chip" data-a="180">180°</button><button class="chip" data-a="270">270°</button>
      </div>
      <div class="ctl" data-k="dcM"></div>
      <div class="row"><label class="name">タイムアウト</label>
        <input type="number" class="inv-dcto" min="1" max="60" step="1"><span class="unit">s (最大60)</span></div>
      <div class="inv-btns"><button class="btn inv-dc">直流励磁</button></div>
      <p class="note">角度を変えると 90°/s で目標角へ回転します。直流は巻線抵抗しか電流を制限しないため m は 0.3 まで。</p>
    </div>

    <div class="only1p">
      <h3>オーディオ <span class="tag">ユニポーラ PWM · ストリーミング</span></h3>
      <div class="row"><input type="file" class="inv-file" accept="audio/*"></div>
      <div class="info inv-audinfo">ファイル未選択</div>
      <div class="ctl" data-k="audM"></div>
      <label class="check"><input type="checkbox" class="inv-loop"> ループ再生</label>
      <div class="meter"><span class="inv-buf"></span></div>
      <div class="inv-btns"><button class="btn inv-play">再生</button><button class="btn inv-astop">停止</button></div>
      <p class="note">再生中はこの画面を前面に表示したままにしてください (裏に回すと送信が止まり無音になります)。</p>
    </div>

    <details class="sub"><summary>シミュレーション設定</summary>
      <div class="row"><label class="name">母線電圧</label>
        <input type="number" class="inv-vbus" min="1" max="400" step="any"><span class="unit">V</span></div>
    </details>`;

  // ---------------- controls ----------------
  const CTL = {
    fc:    { label: "キャリア", min: INV.FC_MIN, max: INV.FC_MAX, log: true, unit: "kHz", scale: 1e3, digits: 4 },
    f:     { label: "基本波", min: INV.F1_MIN, max: INV.F1_MAX, log: true, unit: "Hz", scale: 1, digits: 5 },
    m:     { label: "振幅 m", min: 0, max: INV.M_MAX, step: 0.01, unit: "", scale: 1, digits: 3 },
    dcDeg: { label: "電気角", min: 0, max: 360, step: 1, unit: "°", scale: 1, digits: 4 },
    dcM:   { label: "DC 振幅", min: 0, max: INV.M_DC_MAX, step: 0.01, unit: "", scale: 1, digits: 3 },
    audM:  { label: "音量 m", min: 0, max: INV.M_MAX, step: 0.01, unit: "", scale: 1, digits: 3 },
  };
  const views = {};
  for (const el of root.querySelectorAll(".ctl")) {
    const k = el.dataset.k, cfg = CTL[k];
    el.innerHTML = `<div class="row"><label class="name">${cfg.label}</label>
      <input type="number" class="num" inputmode="decimal" step="any"><span class="unit">${cfg.unit}</span></div>
      <input type="range" class="range" min="0" max="1000" step="1">`;
    const num = $(".num", el), range = $(".range", el);
    const toR = (v) => cfg.log ? (Math.log10(v) - Math.log10(cfg.min)) / (Math.log10(cfg.max) - Math.log10(cfg.min)) * 1000
                               : (v - cfg.min) / (cfg.max - cfg.min) * 1000;
    const fromR = (r) => {
      if (cfg.log) return Number((10 ** (Math.log10(cfg.min) + r / 1000 * (Math.log10(cfg.max) - Math.log10(cfg.min)))).toPrecision(3));
      return Math.round((cfg.min + r / 1000 * (cfg.max - cfg.min)) / cfg.step) * cfg.step;
    };
    const show = () => {
      num.value = Number((S[k] / cfg.scale).toPrecision(cfg.digits));
      range.value = toR(S[k]);
    };
    const set = (v) => {
      if (!isFinite(v)) return show();
      S[k] = Math.min(Math.max(Number(v.toPrecision(6)), cfg.min), cfg.max);
      show();
      changed(k);
    };
    range.addEventListener("input", () => set(fromR(+range.value)));
    num.addEventListener("change", () => set(parseFloat(num.value) * cfg.scale));
    views[k] = show;
    show();
  }
  const accelIn = $(".inv-accel", root), dctoIn = $(".inv-dcto", root), vbusIn = $(".inv-vbus", root);
  const loopIn = $(".inv-loop", root);
  accelIn.value = S.accel; dctoIn.value = S.dcTo; vbusIn.value = S.vbus; loopIn.checked = S.loop;
  accelIn.addEventListener("change", () => { S.accel = Math.min(Math.max(+accelIn.value || 100, 0.1), 100000); accelIn.value = S.accel; changed("accel"); });
  dctoIn.addEventListener("change", () => { S.dcTo = Math.min(Math.max(Math.round(+dctoIn.value) || 10, 1), 60); dctoIn.value = S.dcTo; changed("dcTo"); });
  vbusIn.addEventListener("change", () => { S.vbus = Math.max(+vbusIn.value || 30, 1); vbusIn.value = S.vbus; save(); api.redraw(); });
  loopIn.addEventListener("change", () => { S.loop = loopIn.checked; save(); });

  const segSel = (sel, v) => root.querySelectorAll(`${sel} button`).forEach((b) => b.classList.toggle("sel", b.dataset.v === v));
  root.querySelectorAll(".inv-mode button").forEach((b) => b.addEventListener("click", () => {
    if (dev.state !== "OFF" && api.connected()) return api.toast("モード切替は無効化してから行ってください", true);
    S.mode = b.dataset.v; save(); layout();
    if (api.connected()) api.send(`INV MODE ${S.mode}`);
  }));
  root.querySelectorAll(".inv-dir button").forEach((b) => b.addEventListener("click", () => {
    S.dir = b.dataset.v; save(); segSel(".inv-dir", S.dir);
    if (api.connected()) api.send(`INV DIR ${S.dir}`);
    api.redraw();
  }));
  root.querySelectorAll(".inv-jog button").forEach((b) => b.addEventListener("click", () => {
    let d = b.dataset.a !== undefined ? +b.dataset.a : S.dcDeg + +b.dataset.d;
    d = ((d % 360) + 360) % 360;
    S.dcDeg = d; views.dcDeg(); changed("dcDeg");
  }));

  // ---------------- buttons ----------------
  $(".inv-enable", root).addEventListener("click", () => {
    if (!api.connected()) return;
    if (!confirm("インバータを有効化します (SD = High、ローサイド ON でブートストラップ充電後にスイッチング開始)。\n配線・母線電圧・非常停止スイッチを確認しましたか？")) return;
    api.send(`INV MODE ${S.mode}`);
    api.send(`INV CARRIER ${S.fc}`);
    api.send(`INV DIR ${S.dir}`);
    api.send("INV ENABLE");
  });
  $(".inv-disable", root).addEventListener("click", () => { stopAudio(false); api.send("INV DISABLE"); });
  $(".inv-run", root).addEventListener("click", () => {
    const e = runError();
    if (e) return api.toast(e, true);
    api.send(runCmd());
  });
  $(".inv-stop", root).addEventListener("click", () => api.send("INV STOP"));
  $(".inv-dc", root).addEventListener("click", () => api.send(dcCmd()));
  $(".inv-play", root).addEventListener("click", playAudio);
  $(".inv-astop", root).addEventListener("click", () => stopAudio(true));
  $(".inv-file", root).addEventListener("change", (e) => e.target.files[0] && convert(e.target.files[0]));

  const calc = () => calcInverter(S.fc);
  const runCmd = () => `INV RUN ${S.f} ${S.m.toFixed(3)} ${S.accel}`;
  const dcCmd = () => `INV DC ${S.dcDeg} ${S.dcM.toFixed(3)} ${S.dcTo}`;
  function runError() {
    const c = calc();
    if (c.fcAct < INV.RATIO * S.f) return `キャリア ${fmtHz(c.fcAct)} が基本波 ${fmtHz(S.f)} の8倍未満です`;
    if (S.m > INV.M_MAX) return "振幅は 0.8 までです";
    return "";
  }

  // 値の変更: 運転中のものだけ即時反映 (ランプはファームウェア側)
  const pend = {};
  function later(key, cmd) {
    clearTimeout(pend[key]);
    pend[key] = setTimeout(() => api.connected() && api.send(cmd()), SEND_DEBOUNCE_MS);
  }
  function changed(k) {
    if (k.startsWith("dc")) lastKind = "DC";
    else if (k === "audM") lastKind = "AUDIO";
    else if (k === "f" || k === "m" || k === "accel") lastKind = "RUN";
    save();
    updateErr();
    api.redraw();
    if (!api.connected()) return;
    const st = dev.state;
    if (k === "fc") {
      if (st === "OFF" || st === "IDLE") later("fc", () => `INV CARRIER ${S.fc}`);
      else api.toast("キャリアは停止中 (OFF / IDLE) のみ変更できます", true);
      if (aud.pcm && calc().fcAct < INV.RATIO * aud.bw) aud.needConvert = true;
    } else if ((k === "f" || k === "m" || k === "accel") && st === "RUN") {
      if (!runError()) later("run", runCmd);
    } else if ((k === "dcDeg" || k === "dcM" || k === "dcTo") && st === "DC") {
      later("dc", dcCmd);
    } else if (k === "audM" && st === "AUDIO") {
      later("aud", () => `INV AUDIO START ${aud.fs} ${aud.bw} ${S.audM.toFixed(3)}`);
    }
  }
  function updateErr() {
    const e = runError();
    $(".inv-err", root).textContent = e;
    $(".inv-run", root).disabled = !!e || !api.connected();
  }

  // ---------------- device replies ----------------
  function kv(line) {
    const o = {};
    for (const t of line.split(/\s+/)) { const i = t.indexOf("="); if (i > 0) o[t.slice(0, i)] = t.slice(i + 1); }
    return o;
  }
  function handleLine(line) {
    if (line.startsWith("AUD ")) {
      const k = kv(line);
      aud.fill = +k.fill; aud.tFill = performance.now(); aud.under = +k.under;
      const pct = Math.min(100, aud.fill / (aud.fs * AUD_TARGET_S) * 100);
      $(".inv-buf", root).style.width = `${pct}%`;
      return true;
    }
    if (line.startsWith("EVT INV")) {
      if (line.includes("FAULT")) api.toast("非常停止: インバータを停止しました", true);
      if (line.includes("DC TIMEOUT")) api.toast("直流励磁がタイムアウトしました");
      if (line.includes("AUDIO END")) stopAudio(false);
      return true;
    }
    if (line.startsWith("ERR INV")) { api.toast(line.slice(8), true); return true; }
    if (!line.startsWith("OK INV")) return false;
    const prev = dev.state;
    dev = kv(line);
    if (dev.mode && dev.mode !== S.mode && dev.state === "OFF") { /* keep UI choice; sent on enable */ }
    if (dev.state !== "AUDIO" && prev === "AUDIO" && aud.playing && dev.state !== "RAMPDOWN") stopAudio(false);
    render();
    return true;
  }

  function render() {
    const st = dev.state || "OFF";
    const pill = $(".inv-pill", root);
    pill.textContent = api.connected() ? st : "未接続";
    pill.className = "pill inv-pill" + (["IDLE", "RUN", "DC", "AUDIO", "PRECHARGE", "RAMPDOWN"].includes(st) ? " warn" : "")
                     + (st === "FAULT" ? " bad" : "");
    let info = "";
    if (api.connected() && dev.fc) {
      info = `fc ${fmtHz(+dev.fc)}  f ${(+dev.f).toFixed(1)} Hz  m ${(+dev.m).toFixed(2)}  θ ${dev.theta}°  SD=${dev.sd}`;
      if (st === "DC" && dev.dcleft) info += `  残り ${dev.dcleft} s`;
      if (st === "AUDIO") info += `  アンダーラン ${aud.under}`;
    } else if (!api.connected()) info = "未接続";
    $(".inv-info", root).textContent = info;
    const fault = $(".inv-fault", root);
    const estop = dev.estop === "1";
    fault.hidden = !(st === "FAULT" || estop);
    fault.textContent = st === "FAULT" ? `異常停止中 (${dev.fault})。スイッチを戻してから「有効化」で復帰します。`
                                       : "非常停止スイッチが押されています";
    const on = api.connected() && supported;
    const enabled = ["IDLE", "RUN", "DC", "AUDIO"].includes(st);
    $(".inv-enable", root).disabled = !on || (st !== "OFF" && st !== "FAULT");
    $(".inv-disable", root).disabled = !on;
    $(".inv-stop", root).disabled = !on || !["RUN", "DC", "AUDIO"].includes(st);
    $(".inv-dc", root).disabled = !on || !(st === "IDLE" || st === "DC");
    $(".inv-play", root).disabled = !on || !aud.pcm || aud.converting || !(st === "IDLE");
    $(".inv-astop", root).disabled = !on || st !== "AUDIO";
    root.querySelectorAll(".inv-mode button").forEach((b) => (b.disabled = on && st !== "OFF"));
    root.querySelectorAll(".inv-dir button").forEach((b) => (b.disabled = on && (st === "RUN" || st === "RAMPDOWN")));
    updateErr();
    $(".inv-run", root).disabled = $(".inv-run", root).disabled || !enabled || st === "AUDIO";
    api.redraw();
  }

  function layout() {
    segSel(".inv-mode", S.mode);
    segSel(".inv-dir", S.dir);
    root.querySelectorAll(".only3p").forEach((e) => (e.hidden = S.mode !== "3P"));
    root.querySelectorAll(".only1p").forEach((e) => (e.hidden = S.mode !== "1P"));
    render();
  }

  // ---------------- audio ----------------
  async function convert(file) {
    aud.converting = true;
    render();
    const info = $(".inv-audinfo", root);
    info.textContent = "変換中…";
    try {
      const c = calc();
      const bw = Math.min(c.fcAct / INV.RATIO, 16000);
      const fs = Math.round(Math.min(48000, Math.max(4000, bw * 2.5)));
      const ctx = new AudioContext();
      const src = await ctx.decodeAudioData(await file.arrayBuffer());
      ctx.close();
      const off = new OfflineAudioContext(1, Math.ceil(src.duration * fs), fs);
      const node = off.createBufferSource();
      node.buffer = src;
      // DC 除去 (スピーカー保護) と帯域制限 (キャリアの 1/8)
      const hp = off.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 20;
      const lp1 = off.createBiquadFilter(); lp1.type = "lowpass"; lp1.frequency.value = bw * 0.9;
      const lp2 = off.createBiquadFilter(); lp2.type = "lowpass"; lp2.frequency.value = bw * 0.9;
      node.connect(hp).connect(lp1).connect(lp2).connect(off.destination);
      node.start();
      const x = (await off.startRendering()).getChannelData(0);
      let peak = 1e-9;
      for (const v of x) peak = Math.max(peak, Math.abs(v));
      const g = 0.98 / peak;
      const pcm = new Int16Array(x.length);
      for (let i = 0; i < x.length; i++) pcm[i] = Math.round(x[i] * g * 32767);
      // overview envelope for the scope
      const B = 800, env = [];
      const step = Math.max(1, Math.floor(pcm.length / B));
      for (let i = 0; i < pcm.length; i += step) {
        let lo = 1, hi = -1;
        for (let j = i; j < Math.min(i + step, pcm.length); j++) { const v = pcm[j] / 32768; if (v < lo) lo = v; if (v > hi) hi = v; }
        env.push([lo, hi]);
      }
      Object.assign(aud, { pcm, fs, bw, name: file.name, dur: pcm.length / fs, env, needConvert: false, file });
      lastKind = "AUDIO";
      info.textContent = `${file.name}  ${aud.dur.toFixed(1)} s  →  fs ${fmtHz(fs)} / 帯域 ${fmtHz(bw)} (キャリア ${fmtHz(c.fcAct)} の 1/8)`;
    } catch (e) {
      info.textContent = `変換できませんでした: ${e.message || e}`;
      aud.pcm = null;
    }
    aud.converting = false;
    render();
  }

  async function playAudio() {
    if (!aud.pcm) return;
    if (aud.needConvert || calc().fcAct < INV.RATIO * aud.bw) {
      api.toast("キャリアが変わったので音声を変換し直します");
      await convert(aud.file);
    }
    aud.sent = 0; aud.fill = 0; aud.tFill = performance.now(); aud.under = 0; aud.playing = true;
    api.send(`INV AUDIO START ${aud.fs} ${aud.bw} ${S.audM.toFixed(3)}`);
    clearInterval(aud.timer);
    aud.timer = setInterval(pump, 10);
  }

  function stopAudio(sendStop) {
    clearInterval(aud.timer);
    aud.timer = 0;
    aud.playing = false;
    if (sendStop && api.connected()) api.send("INV AUDIO STOP");
    api.redraw();
  }

  function pump() {
    if (!aud.playing || !api.connected()) return stopAudio(false);
    if (dev.state !== "AUDIO") return;           // wait for the device to accept START
    let est = aud.fill - (performance.now() - aud.tFill) / 1000 * aud.fs;
    for (let k = 0; k < 8 && est < aud.fs * AUD_TARGET_S; k++) {
      if (aud.sent >= aud.pcm.length) {
        if (S.loop) aud.sent = 0; else break;
      }
      const n = Math.min(AUD_FRAME, aud.pcm.length - aud.sent);
      const frame = new Uint8Array(3 + 2 * n);
      frame[0] = 0x02; frame[1] = (2 * n) & 0xff; frame[2] = (2 * n) >> 8;
      frame.set(new Uint8Array(aud.pcm.buffer, aud.sent * 2, 2 * n), 3);
      api.sendBytes(frame);
      aud.sent += n;
      aud.fill += n;
      est += n;
    }
    api.redraw();
  }

  // ---------------- lifecycle ----------------
  let pollTimer = 0;
  function onConnect() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (api.connected() && dev.state && dev.state !== "OFF" && dev.state !== "FAULT") api.send("INV STATUS");
    }, POLL_MS);
    render();
  }
  function onDisconnect() {
    clearInterval(pollTimer);
    stopAudio(false);
    dev = { state: "OFF" };
    render();
  }
  function setSupported(ok) {
    supported = ok;
    if (!ok) $(".inv-info", root).textContent = "このファームウェアはインバータ非対応です (v2 以降を書き込んでください)";
    render();
  }

  // for the scope
  function simState() {
    const st = dev.state;
    const live = api.connected() && ["RUN", "DC", "AUDIO", "RAMPDOWN", "IDLE"].includes(st);
    // 動作中はその内容、それ以外は最後に操作した項目をプレビュー
    let kind = ["RUN", "DC", "AUDIO"].includes(st) && api.connected() ? st : lastKind;
    if (kind === "DC" && S.mode !== "3P") kind = "RUN";
    if (kind === "AUDIO" && S.mode !== "1P") kind = "RUN";
    const pos = aud.playing && aud.pcm ? ((aud.sent - aud.fill) % aud.pcm.length + aud.pcm.length) % aud.pcm.length / aud.pcm.length : -1;
    // 運転中はデバイスの実際の値 (ランプ途中を含む)、それ以外は設定値
    const running = live && st === "RUN" && +dev.f > 0.5;
    let m = kind === "DC" ? S.dcM : kind === "AUDIO" ? S.audM : S.m;
    if (running || (live && (st === "DC" || st === "AUDIO"))) m = +dev.m;
    return {
      mode: S.mode, c: live && dev.fc ? calcInverter(+dev.fc) : calc(), f: running ? +dev.f : S.f,
      rev: S.dir === "REV", vbus: S.vbus, m, kind,
      theta: (kind === "DC" ? (live ? +dev.theta : S.dcDeg) : 0) * Math.PI / 180,
      active: live && st !== "IDLE",
      audio: aud.pcm ? { name: aud.name, fs: aud.fs, bw: aud.bw, dur: aud.dur, env: aud.env, pos, pcm: aud.pcm } : null,
    };
  }

  layout();
  return { handleLine, onConnect, onDisconnect, setSupported, simState };
}
