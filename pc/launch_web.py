"""FuncGen PC アプリの起動: web/ をローカル配信し、Chrome / Edge のアプリ窓で開く

    pythonw pc/launch_web.py              (fgen_gui.bat から。窓を閉じるとサーバーも終了)
    python  pc/launch_web.py --no-browser (サーバーだけ起動。Ctrl+C で終了)

標準ライブラリのみ使用。localhost は安全なコンテキストなので Web Serial が使える。
"""

import ctypes
import http.server
import os
import socket
import subprocess
import sys
import threading
import urllib.request
from pathlib import Path

HOST, PORT = "127.0.0.1", 8765          # 固定 (保存設定・シリアル許可はオリジン単位)
ROOT = Path(__file__).resolve().parent.parent / "web"
URL = f"http://{HOST}:{PORT}/"
PROFILE = Path(os.environ.get("LOCALAPPDATA", Path.home())) / "picofunc" / "browser"


class Handler(http.server.SimpleHTTPRequestHandler):
    # Windows のレジストリ次第で .js が text/plain になると ES Modules が読めないので固定する
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".webmanifest": "application/manifest+json",
        ".svg": "image/svg+xml", ".png": "image/png", ".html": "text/html", ".css": "text/css",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, *args):
        pass


def message(text):
    try:
        ctypes.windll.user32.MessageBoxW(None, text, "FuncGen", 0x10)
    except Exception:
        print(text, file=sys.stderr)


def port_in_use():
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex((HOST, PORT)) == 0


def ours_running():
    try:
        with urllib.request.urlopen(URL, timeout=1) as r:
            return b"FuncGen" in r.read(4096)
    except Exception:
        return False


def find_browser():
    env = os.environ
    cands = []
    for base in (env.get("ProgramFiles"), env.get("ProgramFiles(x86)"), env.get("LOCALAPPDATA")):
        if base:
            cands.append(Path(base) / "Google/Chrome/Application/chrome.exe")
    for base in (env.get("ProgramFiles(x86)"), env.get("ProgramFiles")):
        if base:
            cands.append(Path(base) / "Microsoft/Edge/Application/msedge.exe")
    return next((str(p) for p in cands if p.is_file()), None)


def main():
    no_browser = "--no-browser" in sys.argv
    server = None
    if port_in_use():
        if not ours_running():
            message(f"ポート {PORT} が他のアプリで使われています。")
            return 1
    else:
        server = http.server.ThreadingHTTPServer((HOST, PORT), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()

    if no_browser:
        print(f"serving {ROOT} at {URL}  (Ctrl+C to stop)")
        try:
            threading.Event().wait()
        except KeyboardInterrupt:
            pass
    else:
        exe = find_browser()
        if not exe:
            message("Chrome または Edge が見つかりません。\n" + URL + " を Chrome / Edge で開いてください。")
            if server:
                threading.Event().wait()    # 手動で開けるようにサーバーは残す
            return 1
        PROFILE.mkdir(parents=True, exist_ok=True)
        # 専用プロファイルにすると、窓が閉じるまでこのプロセスが残る
        proc = subprocess.Popen([exe, f"--app={URL}", f"--user-data-dir={PROFILE}", "--no-first-run",
                                 "--no-default-browser-check", "--window-size=1440,900"])
        proc.wait()
    if server:
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())
