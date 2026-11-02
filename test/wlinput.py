#!/usr/bin/env python3
"""Real pointer and keys for a headless KWin through org_kde_kwin_fake_input, with no dependencies.

KWin has to run with KWIN_WAYLAND_NO_PERMISSION_CHECKS=1. XDG_RUNTIME_DIR and WAYLAND_DISPLAY say which one.

Usage: wlinput.py at:860,696 click type:hello key:enter key:ctrl+a rclick press release sleep:0.2
"""
import os, socket, struct, sys, time

LEFT, RIGHT = 0x110, 0x111
REQ_BUTTON, REQ_MOVE, REQ_KEY = 2, 9, 10
CLICK_HOLD = 0.03

def pad(b): return b + b"\0" * ((4 - len(b) % 4) % 4)
def wl_str(s):
    b = s.encode() + b"\0"
    return struct.pack("<I", len(b)) + pad(b)

class Wl:
    def __init__(self):
        path = os.path.join(os.environ["XDG_RUNTIME_DIR"], os.environ["WAYLAND_DISPLAY"])
        self.s = socket.socket(socket.AF_UNIX); self.s.connect(path); self.next = 2; self.buf = b""
    def req(self, obj, op, payload=b""):
        self.s.sendall(struct.pack("<II", obj, ((8 + len(payload)) << 16) | op) + payload)
    def new(self):
        self.next += 1; return self.next - 1
    def events(self, timeout):
        self.s.settimeout(timeout)
        try:
            while True:
                self.buf += self.s.recv(65536)
                while len(self.buf) >= 8:
                    obj, so = struct.unpack("<II", self.buf[:8]); size = so >> 16
                    if len(self.buf) < size: break
                    yield obj, so & 0xffff, self.buf[8:size]; self.buf = self.buf[size:]
        except socket.timeout:
            return

KEYS = {c: k for k, c in enumerate("1234567890", 2)}
KEYS.update({c: k for c, k in zip("qwertyuiop", range(16, 26))})
KEYS.update({c: k for c, k in zip("asdfghjkl", range(30, 39))})
KEYS.update({c: k for c, k in zip("zxcvbnm", range(44, 51))})
KEYS.update({" ": 57, "-": 12, "=": 13, "/": 53, ".": 52, ",": 51, ";": 39, "'": 40, "`": 41, "\\": 43, "[": 26, "]": 27})
SHIFTED = {"@": "2", "~": "`", ":": ";", "_": "-", "+": "=", "!": "1", "?": "/", ")": "0", "(": "9"}
NAMED = {"enter": 28, "esc": 1, "tab": 15, "up": 103, "down": 108, "left": 105, "right": 106, "home": 102, "end": 107, "pageup": 104, "pagedown": 109, "bs": 14, "del": 111, "ctrl": 29, "shift": 42, "alt": 56}
SHIFT = NAMED["shift"]

def key_code(name):
    if name in NAMED: return NAMED[name]
    if name in KEYS: return KEYS[name]
    sys.exit(f"unknown key: {name}")

def main(args):
    wl = Wl()
    registry = wl.new(); wl.req(1, 1, struct.pack("<I", registry))
    fake = None
    for obj, op, data in wl.events(0.3):
        if obj == registry and op == 0:
            name = struct.unpack("<I", data[:4])[0]; n = struct.unpack("<I", data[4:8])[0]
            iface = data[8:8 + n - 1].decode(); ver = struct.unpack("<I", data[8 + ((n + 3) & ~3):][:4])[0]
            if iface == "org_kde_kwin_fake_input":
                fake = wl.new()
                wl.req(registry, 0, struct.pack("<I", name) + wl_str(iface) + struct.pack("<I", min(ver, 4)) + struct.pack("<I", fake))
    if fake is None: sys.exit("no org_kde_kwin_fake_input")
    wl.req(fake, 0, wl_str("herdr-mattermost") + wl_str("test"))
    def button(code, state): wl.req(fake, REQ_BUTTON, struct.pack("<II", code, state))
    def click(code): button(code, 1); time.sleep(CLICK_HOLD); button(code, 0)
    def key(code, state): wl.req(fake, REQ_KEY, struct.pack("<II", code, state)); time.sleep(0.012)
    def tap(code): key(code, 1); time.sleep(0.02); key(code, 0)
    for a in args:
        if a.startswith("key:"):
            parts = a[4:].split("+")
            mods = [key_code(p) for p in parts[:-1]]
            for m in mods: key(m, 1)
            tap(key_code(parts[-1]))
            for m in reversed(mods): key(m, 0)
        elif a.startswith("type:"):
            for ch in a[5:]:
                if ch in SHIFTED: key(SHIFT, 1); tap(key_code(SHIFTED[ch])); key(SHIFT, 0)
                elif ch.isupper(): key(SHIFT, 1); tap(key_code(ch.lower())); key(SHIFT, 0)
                else: tap(key_code(ch))
                time.sleep(0.02)
        elif a.startswith("sleep:"): time.sleep(float(a[6:]))
        elif a.startswith("at:"):
            x, y = map(float, a[3:].split(","))
            wl.req(fake, REQ_MOVE, struct.pack("<ii", int(x * 256), int(y * 256)))
        elif a == "click": click(LEFT)
        elif a == "rclick": click(RIGHT)
        elif a == "press": button(LEFT, 1)
        elif a == "release": button(LEFT, 0)
        else: sys.exit(f"unknown step: {a}")
        time.sleep(CLICK_HOLD)
    wl.req(1, 0, struct.pack("<I", wl.new()))
    list(wl.events(0.2))

main(sys.argv[1:])
