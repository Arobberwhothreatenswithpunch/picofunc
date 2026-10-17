"""出力波形シミュレーション (ファームウェアと同じ計算で実出力を予測し、オシロ風に描画)"""

import math
import tkinter as tk
from fractions import Fraction

# ---- firmware constants (src/main.cpp と一致させること) ----
SYS_HZ = 200e6
VDD = 3.3
PWM_F_MIN, PWM_F_MAX = 0.1, 25e6
WAVE_TOP = 511
WAVE_FULL = WAVE_TOP + 1
WAVE_N_MAX, WAVE_N_MIN = 4096, 16

EXACT_MAX_CYCLES = 20000   # これ以下ならキャリア1周期ずつ厳密に RC を計算
B_LANE = 4.5               # CH1 反転出力を表示する縦位置オフセット [V]


def _lround(x):
    return int(math.floor(x + 0.5))


# =====================================================================
# firmware の再現
# =====================================================================
def calc_pwm(freq, duty):
    freq = min(max(freq, PWM_F_MIN), PWM_F_MAX)
    duty = min(max(duty, 0.0), 100.0)
    hw_min = SYS_HZ / (65535.0 * (255.0 + 15.0 / 16.0))
    if freq >= hw_min * 1.001:
        period = SYS_HZ / freq
        div16 = 16
        if period > 65535.0:
            div16 = min(math.ceil(period * 16.0 / 65535.0), 255 * 16 + 15)
        top1 = min(max(_lround(period * 16.0 / div16), 2), 65535)
        level = _lround(duty / 100.0 * top1)
        f = SYS_HZ * 16.0 / div16 / top1
        return {"mode": "HW", "f": f, "duty": 100.0 * level / top1, "steps": top1,
                "period": 1.0 / f, "high": level / top1 / f}
    if duty <= 0.0 or duty >= 100.0:
        return {"mode": "DC", "f": freq, "duty": duty, "steps": 0,
                "period": 1.0 / freq, "high": (1.0 / freq) if duty >= 100 else 0.0}
    period_us = _lround(1e6 / freq)
    hi = max(_lround(period_us * duty / 100.0), 1)
    lo = max(period_us - hi, 1)
    return {"mode": "SW", "f": 1e6 / (hi + lo), "duty": 100.0 * hi / (hi + lo), "steps": 0,
            "period": (hi + lo) * 1e-6, "high": hi * 1e-6}


def wave_shape(kind, ph):
    if kind == "SINE":
        return math.sin(2 * math.pi * ph)
    if kind == "TRI":
        return 4 * ph if ph < 0.25 else (2 - 4 * ph if ph < 0.75 else 4 * ph - 4)
    if kind == "SAW":
        return 2 * ph - 1
    return 1.0 if ph < 0.5 else -1.0


def calc_wave(kind, freq, amp, ofs):
    amp = min(max(amp, 0.0), 100.0)
    ofs = min(max(ofs, 0.0), 100.0)
    carrier = SYS_HZ / WAVE_FULL
    freq = min(max(freq, SYS_HZ / 65535.0 / WAVE_N_MAX), carrier / WAVE_N_MIN)
    n = min(max(int(math.floor(carrier / freq)), WAVE_N_MIN), WAVE_N_MAX)
    frac = Fraction(freq * n / SYS_HZ).limit_denominator(65535)
    if frac.numerator == 0:
        frac = Fraction(1, 65535)
    fs = SYS_HZ * frac.numerator / frac.denominator
    levels = []
    for i in range(n):
        y = min(max(ofs / 100.0 + amp / 200.0 * wave_shape(kind, i / n), 0.0), 1.0)
        levels.append(_lround(y * WAVE_FULL))
    return {"f": fs / n, "n": n, "fs": fs, "carrier": carrier, "levels": levels}


# =====================================================================
# CH2 出力の時間波形
# =====================================================================
def wave_ideal(w, t_win):
    """RC なし: PWM 平均値 (DMA で更新されるサンプル&ホールド階段)"""
    n, fs, lv = w["n"], w["fs"], w["levels"]
    ts, vp, vn = [], [], []
    count = int(math.ceil(t_win * fs)) + 1
    for k in range(count):
        d = lv[k % n] / WAVE_FULL
        t0, t1 = k / fs, (k + 1) / fs
        ts += [t0, t1]
        vp += [d * VDD] * 2
        vn += [(1 - d) * VDD] * 2
    return ts, vp, vn


def wave_rc(w, rc, t_win):
    """各ピン → R → C(GND) の1次 RC を通した電圧。区分一定入力を厳密解で更新"""
    n, fs, lv = w["n"], w["fs"], w["levels"]
    period = n / fs
    avg = sum(lv) / n / WAVE_FULL
    vp, vn = avg * VDD, (1 - avg) * VDD          # DC 平均から始めて収束を早める
    settle = min(math.ceil(5 * rc / period), 50)
    tc = WAVE_FULL / SYS_HZ
    t_start = settle * period
    t_end = t_start + t_win
    ts, op, on = [], [], []

    if t_end / tc <= EXACT_MAX_CYCLES:
        # キャリア1周期ごと: High 区間 → Low 区間 (− 側は逆相)
        cache = {}
        c = 0
        while True:
            t = c * tc
            if t > t_end:
                break
            v = lv[int(t * fs) % n]
            if v not in cache:
                th = v / WAVE_FULL * tc
                cache[v] = (th, math.exp(-th / rc), math.exp(-(tc - th) / rc))
            th, eh, el = cache[v]
            if t >= t_start:
                ts.append(t - t_start); op.append(vp); on.append(vn)
            vp = VDD + (vp - VDD) * eh
            vn = vn * eh
            if t >= t_start:
                ts.append(t + th - t_start); op.append(vp); on.append(vn)
            vp = vp * el
            vn = VDD + (vn - VDD) * el
            c += 1
    else:
        # キャリアが速すぎる区間はサンプル単位の平均入力で近似 (リップルは省略)
        dt = 1.0 / fs
        e = math.exp(-dt / rc)
        settle = min(settle, 5)
        t_start = settle * period
        total = int(math.ceil((t_start + t_win) * fs)) + 1
        for k in range(total):
            t = k * dt
            if t >= t_start:
                ts.append(t - t_start); op.append(vp); on.append(vn)
            d = lv[k % n] / WAVE_FULL
            vp = d * VDD + (vp - d * VDD) * e
            vn = (1 - d) * VDD + (vn - (1 - d) * VDD) * e
    return ts, op, on


# =====================================================================
# formatting helpers
# =====================================================================
def nice_ceil(x):
    """x 以上で最小の 1-2-5 系列の値"""
    if x <= 0:
        return 1.0
    e = math.floor(math.log10(x))
    for m in (1, 2, 5, 10):
        if m * 10 ** e >= x * 0.9999:
            return m * 10 ** e
    return 10 ** (e + 1)


def fmt_time(s):
    a = abs(s) * (1 + 1e-9)   # 0.000999999... を 1 ms として扱う
    for scale, unit in ((1, "s"), (1e-3, "ms"), (1e-6, "µs")):
        if a >= scale:
            return f"{s / scale:.4g} {unit}"
    return f"{s * 1e9:.4g} ns"


def fmt_hz(f):
    if f >= 1e6:
        return f"{f / 1e6:.6g} MHz"
    if f >= 1e3:
        return f"{f / 1e3:.6g} kHz"
    return f"{f:.6g} Hz"


# =====================================================================
# 描画
# =====================================================================
C = {
    "bg": "#0d1117", "pane": "#11161d", "grid": "#222b36", "axis": "#3a4656",
    "text": "#c9d1d9", "dim": "#6e7a88",
    "ch1": "#f2cc60", "ch1b": "#a07e2c",
    "p": "#56c8f5", "n": "#f07ab0", "diff": "#7ee787",
    "on": "#3fb950", "off": "#6e7a88",
}
FONT = ("Consolas", 9)
FONT_B = ("Consolas", 10, "bold")
FONT_JP = ("Yu Gothic UI", 9)


class Scope(tk.Canvas):
    ML, MR, MT, MB = 46, 12, 24, 20   # pane margins

    def __init__(self, parent, **kw):
        super().__init__(parent, bg=C["bg"], highlightthickness=0, **kw)

    # ---- pane frame ----
    def _pane(self, x0, y0, x1, y1, vmin, vmax, vdiv, tdiv, title, active):
        self.create_rectangle(x0, y0, x1, y1, fill=C["pane"], outline=C["axis"])
        px0, py0 = x0 + self.ML, y0 + self.MT
        px1, py1 = x1 - self.MR, y1 - self.MB
        w, h = px1 - px0, py1 - py0
        for i in range(11):
            x = px0 + w * i / 10
            self.create_line(x, py0, x, py1, fill=C["grid"], dash=(1, 3) if i % 5 else ())
        ndiv = round((vmax - vmin) / vdiv)
        for i in range(ndiv + 1):
            v = vmin + i * vdiv
            y = py1 - h * i / ndiv
            self.create_line(px0, y, px1, y,
                             fill=C["axis"] if abs(v) < 1e-9 else C["grid"],
                             dash=() if abs(v) < 1e-9 else (1, 3))
            self.create_text(px0 - 6, y, text=f"{v:g}V", anchor="e", fill=C["dim"], font=FONT)
        self.create_rectangle(px0, py0, px1, py1, outline=C["axis"])
        tid = self.create_text(x0 + 8, y0 + 12, text=title, anchor="w", fill=C["text"], font=FONT_B)
        self._title_end = self.bbox(tid)[2]
        self.create_text(px1, py1 + 11, text=f"{fmt_time(tdiv)}/div", anchor="e",
                         fill=C["dim"], font=FONT)
        st, col = ("● 出力中", C["on"]) if active else ("○ プレビュー", C["off"])
        self.create_text(self._title_end + 14, y0 + 12, text=st, anchor="w", fill=col, font=FONT_JP)
        self._legend_right = px1

        def mapper(t, v):
            return px0 + t / (tdiv * 10) * w, py1 - (v - vmin) / (vmax - vmin) * h
        return mapper, (px0, py0, px1, py1)

    def _trace(self, mapper, box, ts, vs, color, width=1.6):
        px0, py0, px1, py1 = box
        pts = [mapper(t, v) for t, v in zip(ts, vs)]
        pts = [(x, y) for x, y in pts if x <= px1 + 1]
        if len(pts) > 2 * (px1 - px0):
            # 1ピクセル列ごとに min/max へ間引き (エンベロープ表示)
            cols = {}
            for x, y in pts:
                k = int(x)
                lo, hi = cols.get(k, (y, y))
                cols[k] = (min(lo, y), max(hi, y))
            pts = []
            for k in sorted(cols):
                lo, hi = cols[k]
                pts += [(k, lo), (k, hi)]
        if len(pts) < 2:
            return
        flat = [c for p in pts for c in (p[0], min(max(p[1], py0), py1))]
        self.create_line(*flat, fill=color, width=width)

    def _legend(self, y, items):
        x = self._legend_right
        for label, color in reversed(items):
            tid = self.create_text(x, y, text=label, anchor="e", fill=C["text"], font=FONT_JP)
            x = self.bbox(tid)[0] - 4
            self.create_line(x - 14, y, x, y, fill=color, width=2)
            x -= 26

    # ---- main ----
    def draw(self, pwm, pwm_active, show_b, wave, wave_active, wave_mode, rc, show):
        self.delete("all")
        W, H = max(self.winfo_width(), 200), max(self.winfo_height(), 200)
        split = int(H * 0.40)

        # ---------- CH1 ----------
        tdiv = nice_ceil(pwm["period"] * 3 / 10)
        title = f"CH1 PWM   {fmt_hz(pwm['f'])}   {pwm['duty']:.3f}%"
        vmin = -5 if show_b else -1
        m, box = self._pane(4, 4, W - 4, split - 2, vmin, 4, 1, tdiv, title, pwm_active)
        tw = tdiv * 10
        T, th = pwm["period"], pwm["high"]
        ts, va = [], []
        k = 0
        while k * T <= tw:
            t0 = k * T
            ts += [t0, t0 + th, t0 + th, t0 + T]
            va += [VDD, VDD, 0, 0]
            k += 1
        if pwm["duty"] <= 0:
            ts, va = [0, tw], [0, 0]
        elif pwm["duty"] >= 100:
            ts, va = [0, tw], [VDD, VDD]
        if show_b:
            self._trace(m, box, ts, [VDD - v - B_LANE for v in va], C["ch1b"], 1.6)
        self._trace(m, box, ts, va, C["ch1"], 1.8)
        info = f"T={fmt_time(T)}  High={fmt_time(th)}  mode={pwm['mode']}"
        if pwm["mode"] == "HW":
            info += f"  分解能 {pwm['steps']} 段"
        self.create_text(box[0], split - 13, text=info, anchor="w", fill=C["dim"], font=FONT_JP)
        legend = [("GPIO0", C["ch1"])] + ([(f"GPIO1 (反転, {-B_LANE:g}V 位置)", C["ch1b"])] if show_b else [])
        self._legend(16, legend)

        # ---------- CH2 ----------
        tdiv = nice_ceil(3 / wave["f"] / 10)
        tw = tdiv * 10
        mode_txt = "RCフィルタ後" if wave_mode == "rc" else "理想 (PWM平均)"
        title = f"CH2 WAVE  {fmt_hz(wave['f'])}   [{mode_txt}]"
        m, box = self._pane(4, split + 2, W - 4, H - 4, -4, 4, 1, tdiv, title, wave_active)
        if wave_mode == "rc" and rc > 0:
            ts, vp, vn = wave_rc(wave, rc, tw)
        else:
            ts, vp, vn = wave_ideal(wave, tw)
        diff = [a - b for a, b in zip(vp, vn)]
        if show["p"]:
            self._trace(m, box, ts, vp, C["p"], 1.3)
        if show["n"]:
            self._trace(m, box, ts, vn, C["n"], 1.3)
        if show["diff"]:
            self._trace(m, box, ts, diff, C["diff"], 1.9)

        win = [d for t, d in zip(ts, diff) if t <= tw]
        vpp = (max(win) - min(win)) if win else 0
        info = f"差動 Vpp={vpp:.3f} V   {wave['n']}点/周期   更新 {fmt_hz(wave['fs'])}"
        if wave_mode == "rc" and rc > 0:
            fc = 1 / (2 * math.pi * rc)
            info += f"   fc={fmt_hz(fc)}"
        self.create_text(box[0], H - 15, text=info, anchor="w", fill=C["dim"], font=FONT_JP)
        legend = [(lbl, C[k]) for k, lbl in (("p", "+ GP2"), ("n", "− GP3"),
                                             ("diff", "差動")) if show[k]]
        self._legend(split + 14, legend)
