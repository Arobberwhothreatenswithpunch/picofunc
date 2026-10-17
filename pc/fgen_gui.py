"""YD-RP2040 簡易ファンクションジェネレータ 操作UI

使い方:
    pip install -r requirements.txt
    python fgen_gui.py
"""

import math
import queue
import threading
import tkinter as tk
from tkinter import ttk, messagebox

import serial
import serial.tools.list_ports

import scope

BAUD = 115200
UNITS = {"Hz": 1.0, "kHz": 1e3, "MHz": 1e6}

PWM_F_MIN, PWM_F_MAX = 0.1, 10e6      # slider range (entry accepts up to 25 MHz)
WAVE_F_MIN, WAVE_F_MAX = 1.0, 24e3
WAVES = [("正弦波", "SINE"), ("三角波", "TRI"), ("のこぎり波", "SAW"), ("矩形波", "SQR")]
DEBOUNCE_MS = 150


def fmt_hz(f: float) -> str:
    if f >= 1e6:
        return f"{f / 1e6:.6g} MHz"
    if f >= 1e3:
        return f"{f / 1e3:.6g} kHz"
    return f"{f:.6g} Hz"


def parse_kv(line: str) -> dict:
    kv = {}
    for tok in line.split():
        if "=" in tok:
            k, v = tok.split("=", 1)
            kv[k] = v
    return kv


class FreqControl:
    """数値入力 + 単位 + 対数スライダー"""

    def __init__(self, parent, row, fmin, fmax, init, on_change):
        self.fmin, self.fmax = fmin, fmax
        self.on_change = on_change
        self.value = init

        ttk.Label(parent, text="周波数").grid(row=row, column=0, sticky="w")
        self.entry = ttk.Entry(parent, width=12, justify="right")
        self.entry.grid(row=row, column=1, sticky="w")
        self.unit = ttk.Combobox(parent, values=list(UNITS), width=5, state="readonly")
        self.unit.grid(row=row, column=2, sticky="w", padx=(4, 0))
        self.scale = ttk.Scale(parent, from_=math.log10(fmin), to=math.log10(fmax),
                               orient="horizontal", length=360, command=self._on_scale)
        self.scale.grid(row=row + 1, column=0, columnspan=4, sticky="we", pady=(2, 6))

        self.entry.bind("<Return>", self._on_entry)
        self.entry.bind("<FocusOut>", self._on_entry)
        self.unit.bind("<<ComboboxSelected>>", lambda e: self._show(self.value))
        self._set(init, from_scale=False)

    def _auto_unit(self, f):
        return "MHz" if f >= 1e6 else ("kHz" if f >= 1e3 else "Hz")

    def _show(self, f):
        self.entry.delete(0, "end")
        self.entry.insert(0, f"{f / UNITS[self.unit.get()]:.6g}")

    def _set(self, f, from_scale):
        self.value = f
        self.unit.set(self._auto_unit(f))
        self._show(f)
        if not from_scale:
            self._updating = True
            self.scale.set(math.log10(min(max(f, self.fmin), self.fmax)))
            self._updating = False

    def _on_scale(self, v):
        if getattr(self, "_updating", False):
            return
        f = 10 ** float(v)
        # round to 3 significant digits so slider values look tidy
        digits = 2 - int(math.floor(math.log10(f)))
        f = round(f, digits)
        self._set(f, from_scale=True)
        self.on_change()

    def _on_entry(self, _e=None):
        try:
            f = float(self.entry.get()) * UNITS[self.unit.get()]
        except ValueError:
            self._show(self.value)
            return
        if f <= 0:
            self._show(self.value)
            return
        if f != self.value:
            self._set(f, from_scale=False)
            self.on_change()


class PercentControl:
    """スライダー + 数値 (%)"""

    def __init__(self, parent, row, label, init, on_change, step=0.1):
        self.on_change = on_change
        self.step = step
        self.var = tk.DoubleVar(value=init)
        ttk.Label(parent, text=label).grid(row=row, column=0, sticky="w")
        self.spin = ttk.Spinbox(parent, from_=0, to=100, increment=step, width=8,
                                textvariable=self.var, command=self._changed, justify="right")
        self.spin.grid(row=row, column=1, sticky="w")
        ttk.Label(parent, text="%").grid(row=row, column=2, sticky="w", padx=(4, 0))
        self.scale = ttk.Scale(parent, from_=0, to=100, orient="horizontal", length=360,
                               command=self._on_scale)
        self.scale.set(init)
        self.scale.grid(row=row + 1, column=0, columnspan=4, sticky="we", pady=(2, 6))
        self.spin.bind("<Return>", lambda e: self._changed())
        self.spin.bind("<FocusOut>", lambda e: self._changed())

    @property
    def value(self):
        try:
            return min(max(float(self.var.get()), 0.0), 100.0)
        except (tk.TclError, ValueError):
            return 0.0

    def _on_scale(self, v):
        self.var.set(round(float(v) / self.step) * self.step)
        self.var.set(round(self.var.get(), 3))
        self.on_change()

    def _changed(self):
        self.scale.set(self.value)
        self.on_change()


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("RP2040 ファンクションジェネレータ")
        self.minsize(1100, 640)
        self._redraw_pending = False
        self.ser = None
        self.rx = queue.Queue()
        self.reader = None
        self._pending = {}

        pad = {"padx": 8, "pady": 6}
        left = ttk.Frame(self)
        left.grid(row=0, column=0, sticky="n")
        self.columnconfigure(1, weight=1)
        self.rowconfigure(0, weight=1)

        # ---- connection ----
        conn = ttk.LabelFrame(left, text="接続")
        conn.grid(row=0, column=0, sticky="we", **pad)
        self.port = ttk.Combobox(conn, width=28, state="readonly")
        self.port.grid(row=0, column=0, padx=4, pady=4)
        ttk.Button(conn, text="更新", command=self.refresh_ports).grid(row=0, column=1, padx=4)
        self.conn_btn = ttk.Button(conn, text="接続", command=self.toggle_connect)
        self.conn_btn.grid(row=0, column=2, padx=4)
        self.conn_status = ttk.Label(conn, text="未接続", foreground="gray")
        self.conn_status.grid(row=0, column=3, padx=8)

        # ---- CH1 PWM ----
        ch1 = ttk.LabelFrame(left, text="CH1  PWM   (GPIO0 = 出力 / GPIO1 = 反転出力)")
        ch1.grid(row=1, column=0, sticky="we", **pad)
        self.pwm_freq = FreqControl(ch1, 0, PWM_F_MIN, PWM_F_MAX, 1000.0,
                                    lambda: self.schedule("pwm"))
        self.pwm_duty = PercentControl(ch1, 2, "デューティー", 50.0,
                                       lambda: self.schedule("pwm"))
        self.pwm_on = tk.BooleanVar(value=False)
        ttk.Checkbutton(ch1, text="出力 ON", variable=self.pwm_on,
                        command=lambda: self.apply("pwm")).grid(row=4, column=0, sticky="w")
        self.pwm_info = ttk.Label(ch1, text="—", foreground="#205080")
        self.pwm_info.grid(row=4, column=1, columnspan=3, sticky="w")

        # ---- CH2 WAVE ----
        ch2 = ttk.LabelFrame(left, text="CH2  波形 (試験的)   (GPIO2 = + / GPIO3 = −  差動)")
        ch2.grid(row=2, column=0, sticky="we", **pad)
        wf = ttk.Frame(ch2)
        wf.grid(row=0, column=0, columnspan=4, sticky="w")
        self.wave_type = tk.StringVar(value="SINE")
        for i, (label, key) in enumerate(WAVES):
            ttk.Radiobutton(wf, text=label, value=key, variable=self.wave_type,
                            command=lambda: self.schedule("wave")).grid(row=0, column=i, padx=(0, 10))
        self.wave_freq = FreqControl(ch2, 1, WAVE_F_MIN, WAVE_F_MAX, 1000.0,
                                     lambda: self.schedule("wave"))
        self.wave_amp = PercentControl(ch2, 3, "振幅 (p-p)", 100.0,
                                       lambda: self.schedule("wave"), step=1)
        self.wave_ofs = PercentControl(ch2, 5, "オフセット", 50.0,
                                       lambda: self.schedule("wave"), step=1)
        self.wave_on = tk.BooleanVar(value=False)
        ttk.Checkbutton(ch2, text="出力 ON", variable=self.wave_on,
                        command=lambda: self.apply("wave")).grid(row=7, column=0, sticky="w")
        self.wave_info = ttk.Label(ch2, text="—", foreground="#205080")
        self.wave_info.grid(row=7, column=1, columnspan=3, sticky="w")
        ttk.Label(ch2, foreground="gray", justify="left",
                  text="※ 各ピンに RC ローパス (例: 1kΩ + 10nF, fc≈16kHz) を入れてください。\n"
                       "   キャリア約390kHz / 9bit。差動出力は (+) − (−) で測定。").grid(
            row=8, column=0, columnspan=4, sticky="w", pady=(4, 0))

        # ---- log ----
        logf = ttk.LabelFrame(left, text="ログ")
        logf.grid(row=3, column=0, sticky="we", **pad)
        self.log = tk.Text(logf, width=70, height=8, font=("Consolas", 9), state="disabled")
        self.log.grid(row=0, column=0)
        sb = ttk.Scrollbar(logf, command=self.log.yview)
        sb.grid(row=0, column=1, sticky="ns")
        self.log["yscrollcommand"] = sb.set

        # ---- simulation ----
        simf = ttk.LabelFrame(self, text="出力シミュレーション")
        simf.grid(row=0, column=1, sticky="nsew", **pad)
        simf.columnconfigure(0, weight=1)
        simf.rowconfigure(0, weight=1)
        self.scope = scope.Scope(simf, width=640, height=520)
        self.scope.grid(row=0, column=0, sticky="nsew", padx=4, pady=4)
        self.scope.bind("<Configure>", lambda e: self.redraw_soon())

        opt = ttk.Frame(simf)
        opt.grid(row=1, column=0, sticky="we", padx=4, pady=(0, 4))
        ttk.Label(opt, text="CH2 表示:").grid(row=0, column=0, sticky="w")
        self.sim_mode = tk.StringVar(value="rc")
        ttk.Radiobutton(opt, text="RCフィルタ後", value="rc", variable=self.sim_mode,
                        command=self.redraw_soon).grid(row=0, column=1, padx=(4, 0))
        ttk.Radiobutton(opt, text="理想 (PWM平均)", value="ideal", variable=self.sim_mode,
                        command=self.redraw_soon).grid(row=0, column=2, padx=(8, 16))
        ttk.Label(opt, text="R").grid(row=0, column=3)
        self.sim_r = tk.StringVar(value="1000")
        ttk.Entry(opt, textvariable=self.sim_r, width=7, justify="right").grid(row=0, column=4)
        ttk.Label(opt, text="Ω   C").grid(row=0, column=5)
        self.sim_c = tk.StringVar(value="10")
        ttk.Entry(opt, textvariable=self.sim_c, width=7, justify="right").grid(row=0, column=6)
        ttk.Label(opt, text="nF").grid(row=0, column=7, padx=(2, 0))
        for v in (self.sim_r, self.sim_c):
            v.trace_add("write", lambda *a: self.redraw_soon())

        traces = ttk.Frame(simf)
        traces.grid(row=2, column=0, sticky="w", padx=4, pady=(0, 4))
        ttk.Label(traces, text="表示トレース:").grid(row=0, column=0)
        self.show = {}
        for i, (key, label, init) in enumerate((("b", "CH1 反転", False), ("p", "CH2 +", True),
                                                 ("n", "CH2 −", True), ("diff", "CH2 差動", True))):
            self.show[key] = tk.BooleanVar(value=init)
            ttk.Checkbutton(traces, text=label, variable=self.show[key],
                            command=self.redraw_soon).grid(row=0, column=i + 1, padx=(6, 0))

        self.refresh_ports()
        self.after(50, self.poll_rx)
        self.protocol("WM_DELETE_WINDOW", self.on_close)

    # ---------------- serial ----------------
    def refresh_ports(self):
        ports = list(serial.tools.list_ports.comports())
        items = [f"{p.device}  {p.description}" for p in ports]
        self.port["values"] = items
        # RP2040 (USB VID 0x2E8A) を優先
        pick = next((i for i, p in enumerate(ports) if p.vid == 0x2E8A), 0 if items else None)
        if pick is not None:
            self.port.current(pick)

    def toggle_connect(self):
        if self.ser:
            self.disconnect()
            return
        sel = self.port.get()
        if not sel:
            messagebox.showwarning("接続", "COMポートを選択してください")
            return
        dev = sel.split()[0]
        try:
            self.ser = serial.Serial(dev, BAUD, timeout=0.1, write_timeout=1.0)
        except serial.SerialException as e:
            messagebox.showerror("接続エラー", str(e))
            self.ser = None
            return
        self.ser.dtr = True
        self.reader = threading.Thread(target=self.read_loop, daemon=True)
        self.reader.start()
        self.conn_btn["text"] = "切断"
        self.conn_status["text"] = f"{dev} 接続中"
        self.conn_status["foreground"] = "green"
        self.send("ID")
        self.send("STATUS")

    def disconnect(self):
        ser, self.ser = self.ser, None
        if ser:
            try:
                ser.close()
            except serial.SerialException:
                pass
        self.conn_btn["text"] = "接続"
        self.conn_status["text"] = "未接続"
        self.conn_status["foreground"] = "gray"
        self.redraw_soon()

    def read_loop(self):
        ser = self.ser
        while self.ser is ser and ser is not None:
            try:
                line = ser.readline()
            except (serial.SerialException, OSError, TypeError):
                self.rx.put(None)
                return
            if line:
                self.rx.put(line.decode(errors="replace").strip())

    def send(self, cmd):
        if not self.ser:
            return
        try:
            self.ser.write((cmd + "\n").encode())
            self.write_log("> " + cmd)
        except serial.SerialException as e:
            self.write_log("! " + str(e))
            self.disconnect()

    def poll_rx(self):
        try:
            while True:
                line = self.rx.get_nowait()
                if line is None:
                    self.write_log("! 接続が切れました")
                    self.disconnect()
                    continue
                self.write_log("< " + line)
                try:
                    self.handle_reply(line)
                except (KeyError, ValueError) as e:
                    # 1行の解析失敗で受信処理全体を止めない
                    self.write_log(f"! 応答を解析できません: {e!r}")
        except queue.Empty:
            pass
        finally:
            self.after(50, self.poll_rx)

    # ---------------- commands ----------------
    def schedule(self, ch):
        """スライダー操作中に送りすぎないようデバウンス"""
        self.redraw_soon()
        if ch in self._pending:
            self.after_cancel(self._pending[ch])
        self._pending[ch] = self.after(DEBOUNCE_MS, lambda: self.apply(ch, only_if_on=True))

    def apply(self, ch, only_if_on=False):
        self._pending.pop(ch, None)
        self.redraw_soon()
        if ch == "pwm":
            if self.pwm_on.get():
                self.send(f"PWM {self.pwm_freq.value:.6g} {self.pwm_duty.value:.4g}")
            elif not only_if_on:
                self.send("PWM OFF")
        else:
            if self.wave_on.get():
                self.send(f"WAVE {self.wave_type.get()} {self.wave_freq.value:.6g} "
                          f"{self.wave_amp.value:.4g} {self.wave_ofs.value:.4g}")
            elif not only_if_on:
                self.send("WAVE OFF")

    def handle_reply(self, line):
        kv = parse_kv(line)
        self.redraw_soon()
        if line.startswith("OK PWM"):
            if " OFF" in line:
                self.pwm_info["text"] = "停止中"
                self.pwm_on.set(False)
            else:
                f, d = float(kv["f"]), float(kv["duty"])
                mode = kv.get("mode", "")
                txt = f"実際: {fmt_hz(f)}  /  {d:.3f} %  [{mode}"
                if mode == "HW":
                    txt += f", 分解能 {kv.get('steps')} 段"
                txt += "]"
                if kv.get("clamped") == "1":
                    txt += "  ※範囲外を制限"
                self.pwm_info["text"] = txt
                self.pwm_on.set(True)
        elif line.startswith("OK WAVE"):
            if " OFF" in line:
                self.wave_info["text"] = "停止中"
                self.wave_on.set(False)
            else:
                txt = (f"実際: {fmt_hz(float(kv['f']))}  [{kv.get('n')} 点/周期, "
                       f"更新 {fmt_hz(float(kv['fs']))}]")
                if kv.get("clamped") == "1":
                    txt += "  ※範囲外を制限"
                self.wave_info["text"] = txt
                self.wave_on.set(True)
        elif line.startswith("OK ID"):
            self.conn_status["text"] += "  (" + line[6:] + ")"
        elif line.startswith("ERR"):
            self.write_log("! " + line)

    # ---------------- simulation ----------------
    def redraw_soon(self):
        """連続した変更は1回の再描画にまとめる"""
        if not self._redraw_pending and hasattr(self, "scope"):
            self._redraw_pending = True
            self.after_idle(self.redraw)

    def redraw(self):
        self._redraw_pending = False
        try:
            rc = float(self.sim_r.get()) * float(self.sim_c.get()) * 1e-9
        except ValueError:
            rc = 0.0
        pwm = scope.calc_pwm(self.pwm_freq.value, self.pwm_duty.value)
        wave = scope.calc_wave(self.wave_type.get(), self.wave_freq.value,
                               self.wave_amp.value, self.wave_ofs.value)
        connected = self.ser is not None
        self.scope.draw(pwm, connected and self.pwm_on.get(), self.show["b"].get(),
                        wave, connected and self.wave_on.get(), self.sim_mode.get(),
                        max(rc, 0.0), {k: v.get() for k, v in self.show.items()})

    # ---------------- misc ----------------
    def write_log(self, text):
        self.log["state"] = "normal"
        self.log.insert("end", text + "\n")
        if int(self.log.index("end-1c").split(".")[0]) > 500:
            self.log.delete("1.0", "100.0")
        self.log.see("end")
        self.log["state"] = "disabled"

    def on_close(self):
        self.disconnect()
        self.destroy()


if __name__ == "__main__":
    App().mainloop()
