// USB シリアル接続
//   - Web Serial : PC (Chrome / Edge)。OS の CDC ドライバ経由
//   - WebUSB     : Android Chrome。CDC-ACM を直接たたく (OS にドライバが無いので claim できる)
// どちらも「1行受信ごとに onLine」「write(text)」の同じインターフェースにする。

const RP2040_VID = 0x2e8a;
const BAUD = 115200;

class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buf = "";
    this.dec = new TextDecoder();
  }
  push(bytes) {
    this.buf += this.dec.decode(bytes, { stream: true });
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }
}

class Base {
  constructor() {
    this.onLine = () => {};
    this.onClose = () => {};
    this.closed = false;
    this._chain = Promise.resolve();
    this._enc = new TextEncoder();
  }
  // 書き込みは直列化 (同時 write で順序が崩れないように)
  write(text) {
    return this.writeBytes(this._enc.encode(text));
  }
  writeBytes(data) {
    this._chain = this._chain.then(() => this._write(data)).catch((e) => this._fail(e));
    return this._chain;
  }
  _fail(e) {
    if (this.closed) return;
    this.closed = true;
    this.onClose(e);
  }
}

// ---------------------------------------------------------------------
class SerialTransport extends Base {
  static supported() { return "serial" in navigator; }
  get kind() { return "Web Serial"; }

  async open() {
    this.port = await navigator.serial.requestPort({ filters: [{ usbVendorId: RP2040_VID }] });
    await this.port.open({ baudRate: BAUD });
    // arduino-pico は DTR が立っていないと送信しないことがある
    await this.port.setSignals({ dataTerminalReady: true, requestToSend: true });
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    const split = new LineSplitter((l) => this.onLine(l));
    (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value) split.push(value);
        }
      } catch (e) {
        this._fail(e);
        return;
      }
      this._fail(new Error("closed"));
    })();
  }
  _write(data) { return this.writer.write(data); }

  async close() {
    this.closed = true;
    try { await this.reader?.cancel(); } catch {}
    try { this.reader?.releaseLock(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await this.port?.close(); } catch {}
  }
}

// ---------------------------------------------------------------------
class UsbCdcTransport extends Base {
  static supported() { return "usb" in navigator; }
  get kind() { return "WebUSB"; }

  async open() {
    this.dev = await navigator.usb.requestDevice({ filters: [{ vendorId: RP2040_VID }] });
    const dev = this.dev;
    await dev.open();
    if (dev.configuration === null) await dev.selectConfiguration(1);

    let ctrl = null, data = null;
    for (const iface of dev.configuration.interfaces) {
      const alt = iface.alternates[0];
      if (alt.interfaceClass === 0x02 && !ctrl) ctrl = iface;          // CDC control
      if (alt.interfaceClass === 0x0a && !data) data = iface;          // CDC data
    }
    if (!data) throw new Error("CDC データインターフェースが見つかりません");
    const eps = data.alternates[0].endpoints;
    this.epIn = eps.find((e) => e.direction === "in" && e.type === "bulk");
    this.epOut = eps.find((e) => e.direction === "out" && e.type === "bulk");
    if (!this.epIn || !this.epOut) throw new Error("bulk エンドポイントが見つかりません");

    if (ctrl) await dev.claimInterface(ctrl.interfaceNumber);
    await dev.claimInterface(data.interfaceNumber);
    this.ctrlIf = ctrl ? ctrl.interfaceNumber : data.interfaceNumber;

    // SET_LINE_CODING (115200 8N1), SET_CONTROL_LINE_STATE (DTR | RTS)
    const lc = new Uint8Array(7);
    new DataView(lc.buffer).setUint32(0, BAUD, true);
    lc[6] = 8;
    await dev.controlTransferOut({ requestType: "class", recipient: "interface",
                                   request: 0x20, value: 0, index: this.ctrlIf }, lc);
    await dev.controlTransferOut({ requestType: "class", recipient: "interface",
                                   request: 0x22, value: 0x03, index: this.ctrlIf });

    const split = new LineSplitter((l) => this.onLine(l));
    const size = this.epIn.packetSize || 64;
    (async () => {
      try {
        while (!this.closed) {
          const r = await dev.transferIn(this.epIn.endpointNumber, size);
          if (r.data && r.data.byteLength) split.push(new Uint8Array(r.data.buffer));
        }
      } catch (e) {
        this._fail(e);
      }
    })();
    this._onDisc = (ev) => { if (ev.device === dev) this._fail(new Error("切断されました")); };
    navigator.usb.addEventListener("disconnect", this._onDisc);
  }
  _write(data) { return this.dev.transferOut(this.epOut.endpointNumber, data); }

  async close() {
    this.closed = true;
    navigator.usb.removeEventListener("disconnect", this._onDisc);
    try {
      await this.dev.controlTransferOut({ requestType: "class", recipient: "interface",
                                          request: 0x22, value: 0x00, index: this.ctrlIf });
    } catch {}
    try { await this.dev.close(); } catch {}
  }
}

// ---------------------------------------------------------------------
export const isAndroid = /Android/i.test(navigator.userAgent);

// method: "auto" | "serial" | "usb"
export function availableMethods() {
  return { serial: SerialTransport.supported(), usb: UsbCdcTransport.supported() };
}

export async function connect(method = "auto") {
  const av = availableMethods();
  let T;
  if (method === "serial") T = SerialTransport;
  else if (method === "usb") T = UsbCdcTransport;
  // Android では WebUSB を優先 (Web Serial の USB 対応は端末/版で差がある)
  else if (isAndroid) T = av.usb ? UsbCdcTransport : SerialTransport;
  else T = av.serial ? SerialTransport : UsbCdcTransport;
  if (!T.supported()) throw new Error("このブラウザは USB シリアルに対応していません (Chrome / Edge を使ってください)");
  const t = new T();
  await t.open();
  return t;
}
