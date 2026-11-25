#!/usr/bin/env python3
"""Records one of the README's demo videos from the sandbox and renders it. See AGENTS.md.

The sandbox shows no pointer, and a wall-clock grab loop records every wait the UI needs. So the panel is driven
one step at a time with a still taken after each, and the video's timing, camera and pointer are laid over those
stills afterwards.

Usage: demo_video.py prepare                       (changes the sandbox's copy of the mod for the recording)
       demo_video.py record demo|demo-jira DIR    (a sandbox at SCALE times 1280x820 must be running)
       demo_video.py render DIR OUT.mp4           (needs Pillow and ffmpeg)
"""
import json, math, os, subprocess, sys, time
from PIL import Image, ImageChops, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.realpath(__file__))
# Steps are written in the 1280x820 coordinates AGENTS.md uses; the sandbox runs at twice that so zoomed text stays sharp.
SCALE = 2
PANEL_W, PANEL_H = 1280 * SCALE, 820 * SCALE
OUT_W, OUT_H = 1600, 1024
FPS = 30
MARGIN_X = 96
STAGE_W = PANEL_W + 2 * MARGIN_X
STAGE_H = round(STAGE_W * OUT_H / OUT_W)
MARGIN_Y = (STAGE_H - PANEL_H) // 2
PARK = (1000, 20)


def sandbox(*args):
    subprocess.run([os.path.join(HERE, "sandbox.sh"), *args], check=True, stdout=subprocess.DEVNULL)


class Recorder:
    def __init__(self, out):
        self.out, self.t, self.pointer = out, 0.0, (900, 560)
        self.frames, self.glides, self.clicks, self.cameras = [], [], [], []
        self.shot(fade=0)

    def input(self, *steps):
        sandbox("in", *steps)

    def at(self, x, y):
        self.input(f"at:{x * SCALE},{y * SCALE}")

    def shot(self, at=None, fade=0.12, wait=0.06):
        time.sleep(wait)
        path = os.path.join(self.out, f"{len(self.frames):04d}.png")
        sandbox("run", "herdr-app", "shot", path)
        if self.frames and ImageChops.difference(Image.open(path).convert("RGB"), Image.open(self.frames[-1]["file"]).convert("RGB")).getbbox() is None:
            os.remove(path)
            return
        self.frames.append({"t": self.t if at is None else at, "file": path, "fade": fade})

    def camera(self, zoom=1.0, at=None, duration=0.8):
        """Starts easing the camera now, while the steps after it play."""
        self.cameras.append({"t": self.t, "duration": duration, "zoom": zoom, "at": at})

    def move(self, x, y, duration=None):
        start = self.pointer
        distance = math.dist(start, (x, y))
        duration = duration or min(0.75, max(0.3, 0.22 + distance / 1500))
        # Whatever the last target lit up on hover goes out as the pointer leaves it.
        self.at(*PARK)
        self.shot(wait=0.12)
        self.glides.append({"t": self.t, "duration": duration, "from": start, "to": (x, y)})
        self.at(x, y)
        self.shot(at=self.t + duration * 0.8, wait=0.15)
        self.t += duration
        self.pointer = (x, y)

    def click(self, settle=0.35, after=0.45):
        self.clicks.append(self.t)
        self.input("click")
        self.shot(at=self.t + 0.08, fade=0.1, wait=settle)
        self.t += after

    def key(self, name, settle=0.3, after=0.4):
        self.input(f"key:{name}")
        self.shot(fade=0.1, wait=settle)
        self.t += after

    def type(self, text, per_second=24, chunk=3):
        for i in range(0, len(text), chunk):
            part = text[i:i + chunk]
            self.input(f"type:{part}")
            self.shot(fade=0)
            self.t += len(part) / per_second

    def hold(self, seconds):
        self.t += seconds

    def save(self):
        with open(os.path.join(self.out, "timeline.json"), "w") as f:
            json.dump({"duration": self.t, "frames": self.frames, "glides": self.glides, "clicks": self.clicks, "cameras": self.cameras}, f, indent=1)


def demo(r):
    r.hold(0.7)
    r.camera(1.7, at=(190, 300))
    r.move(200, 130)
    r.click(settle=0.6)
    r.camera(1.6, at=(830, 400))
    r.move(535, 442)
    r.click(settle=0.6, after=0.1)
    r.camera(1.75, at=(830, 650))
    r.hold(0.5)
    r.move(700, 790)
    r.click(settle=0.2, after=0.2)
    r.type("Checked them, looks great. Ship it!")
    r.hold(0.2)
    r.key("enter", settle=0.6, after=1.4)
    r.camera(1.0)
    r.move(144, 24)
    r.camera(2.0, at=(300, 200))
    r.click(settle=0.6, after=1.6)
    r.camera(1.0)
    r.move(240, 24)
    r.click(settle=0.6, after=1.6)
    r.move(336, 24)
    r.click(settle=0.6, after=1.5)
    r.move(48, 24)
    r.click(settle=0.5, after=0.7)
    r.move(1340, 900)
    r.hold(0.3)


def demo_jira(r):
    r.hold(1.2)
    r.move(192, 24)
    r.camera(1.4, at=(457, 293))
    r.click(settle=0.8, after=1.6)
    for y in (190, 258):
        r.move(200, y)
        r.click(settle=0.6, after=1.4)
    r.move(140, 71)
    r.click(settle=0.6, after=0.3)
    r.move(200, 120)
    r.click(settle=0.8, after=1.5)
    r.move(57, 71)
    r.click(settle=0.6, after=0.3)
    r.move(200, 120)
    r.click(settle=0.6, after=0.4)
    r.camera(1.9, at=(560, 300))
    r.move(640, 394)
    r.click(settle=0.6, after=1.4)
    r.camera(1.0)
    r.move(40, 24)
    r.click(settle=0.6, after=1.0)
    r.move(1340, 900)
    r.hold(0.3)


SCENARIOS = {"demo": demo, "demo-jira": demo_jira}


def ease(x):
    x = max(0.0, min(1.0, x))
    return 4 * x ** 3 if x < 0.5 else 1 - (-2 * x + 2) ** 3 / 2


def stage_point(x, y):
    return MARGIN_X + x * SCALE, MARGIN_Y + y * SCALE


class Renderer:
    def __init__(self, folder):
        with open(os.path.join(folder, "timeline.json")) as f:
            self.tl = json.load(f)
        self.cache = {}
        self.backdrop = self.make_backdrop()
        self.arrow = self.make_arrow()
        self.arrows = {}

    def make_backdrop(self):
        small = Image.new("RGB", (64, 41))
        px = small.load()
        for y in range(41):
            for x in range(64):
                d = math.hypot((x - 20) / 64, (y - 8) / 41)
                k = max(0.0, 1 - d * 1.4)
                px[x, y] = tuple(round(a + (b - a) * k) for a, b in zip((12, 13, 17), (34, 40, 52)))
        backdrop = small.resize((STAGE_W, STAGE_H), Image.BICUBIC)
        radius = 10 * SCALE
        shadow = Image.new("L", (STAGE_W, STAGE_H), 0)
        ImageDraw.Draw(shadow).rounded_rectangle((MARGIN_X, MARGIN_Y + 14, MARGIN_X + PANEL_W, MARGIN_Y + PANEL_H + 14), radius, fill=150)
        shadow = shadow.filter(ImageFilter.GaussianBlur(28))
        backdrop.paste((0, 0, 0), (0, 0), shadow)
        mask = Image.new("L", (PANEL_W * 2, PANEL_H * 2), 0)
        ImageDraw.Draw(mask).rounded_rectangle((0, 0, PANEL_W * 2 - 1, PANEL_H * 2 - 1), radius * 2, fill=255)
        self.mask = mask.resize((PANEL_W, PANEL_H), Image.LANCZOS)
        return backdrop

    def stage(self, i):
        if i not in self.cache:
            if len(self.cache) > 3:
                self.cache.pop(min(self.cache))
            panel = Image.open(self.tl["frames"][i]["file"]).convert("RGB")
            neutral_border(panel)
            stage = self.backdrop.copy()
            stage.paste(panel, (MARGIN_X, MARGIN_Y), self.mask)
            self.cache[i] = stage
        return self.cache[i]

    def picture(self, t):
        frames = self.tl["frames"]
        i = max(k for k, f in enumerate(frames) if f["t"] <= t or k == 0)
        f = frames[i]
        if i > 0 and f["fade"] and t < f["t"] + f["fade"]:
            return Image.blend(self.stage(i - 1), self.stage(i), ease((t - f["t"]) / f["fade"]))
        return self.stage(i)

    def camera(self, t):
        z, (cx, cy) = 1.0, (STAGE_W / 2, STAGE_H / 2)
        for c in self.tl["cameras"]:
            if c["t"] > t:
                break
            tz = c["zoom"]
            tx, ty = stage_point(*c["at"]) if c["at"] else (STAGE_W / 2, STAGE_H / 2)
            k = ease((t - c["t"]) / c["duration"])
            z = math.exp(math.log(z) + (math.log(tz) - math.log(z)) * k)
            cx, cy = cx + (tx - cx) * k, cy + (ty - cy) * k
        w, h = STAGE_W / z, STAGE_H / z
        x0 = min(max(cx - w / 2, 0), STAGE_W - w)
        y0 = min(max(cy - h / 2, 0), STAGE_H - h)
        return x0, y0, w, h

    def pointer(self, t):
        pos = self.tl["glides"][0]["from"] if self.tl["glides"] else (900, 560)
        for g in self.tl["glides"]:
            if g["t"] > t:
                break
            k = ease((t - g["t"]) / g["duration"])
            (ax, ay), (bx, by) = g["from"], g["to"]
            # A slight bow, as a hand moves, rather than a ruler-straight line.
            bow = math.sin(math.pi * k) * 0.08
            pos = (ax + (bx - ax) * k - (by - ay) * bow, ay + (by - ay) * k + (bx - ax) * bow)
        return stage_point(*pos)

    def make_arrow(self):
        s = 16
        shape = [(0, 0), (0, 17), (4.2, 13.2), (7, 19.6), (9.6, 18.5), (6.9, 12.3), (12.4, 12.3)]
        size = (int(16 * s), int(24 * s))
        off = (2 * s, 2 * s)
        pts = [(off[0] + x * s, off[1] + y * s) for x, y in shape]
        sprite = Image.new("RGBA", size, (0, 0, 0, 0))
        shadow = Image.new("L", size, 0)
        ImageDraw.Draw(shadow).polygon([(x + 0.8 * s, y + 1.2 * s) for x, y in pts], fill=110)
        sprite.putalpha(shadow.filter(ImageFilter.GaussianBlur(1.1 * s)))
        d = ImageDraw.Draw(sprite)
        d.polygon(pts, fill=(20, 20, 20, 255))
        inner = [(x, y) for x, y in shape]
        cx = sum(x for x, _ in inner) / len(inner)
        cy = sum(y for _, y in inner) / len(inner)
        shrink = [(off[0] + (cx + (x - cx) * 0.8) * s, off[1] + (cy + (y - cy) * 0.86) * s) for x, y in inner]
        d.polygon(shrink, fill=(255, 255, 255, 255))
        return sprite, off

    def arrow_at(self, height):
        key = round(height * 2)
        if key not in self.arrows:
            sprite, (ox, oy) = self.arrow
            k = height / sprite.size[1]
            self.arrows[key] = (sprite.resize((max(1, round(sprite.size[0] * k)), max(1, round(sprite.size[1] * k))), Image.LANCZOS), (ox * k, oy * k))
        return self.arrows[key]

    def frame(self, t):
        x0, y0, w, h = self.camera(t)
        out = self.picture(t).resize((OUT_W, OUT_H), Image.BICUBIC, box=(x0, y0, x0 + w, y0 + h)).convert("RGBA")
        k = OUT_W / w
        px, py = self.pointer(t)
        ox, oy = (px - x0) * k, (py - y0) * k
        size = 26 * (k / (OUT_W / STAGE_W)) ** 0.5
        layer = Image.new("RGBA", out.size, (0, 0, 0, 0))
        press = 1.0
        for c in self.tl["clicks"]:
            age = t - c
            if 0 <= age < 0.45:
                p = age / 0.45
                r = (6 + 30 * (1 - (1 - p) ** 2)) * size / 26
                a = round(200 * (1 - p) ** 1.5)
                ring = Image.new("RGBA", (int(r * 2 + 8) * 4,) * 2, (0, 0, 0, 0))
                c4 = ring.size[0] / 2
                ImageDraw.Draw(ring).ellipse((c4 - r * 4, c4 - r * 4, c4 + r * 4, c4 + r * 4), fill=(61, 174, 233, a // 3), outline=(160, 215, 245, a), width=round(2.5 * 4 * size / 26))
                ring = ring.resize((ring.size[0] // 4,) * 2, Image.LANCZOS)
                layer.alpha_composite(ring, (round(ox - ring.size[0] / 2), round(oy - ring.size[1] / 2)))
            if 0 <= age < 0.2:
                press = min(press, 1 - 0.14 * math.sin(math.pi * age / 0.2))
        sprite, (hx, hy) = self.arrow_at(size * press)
        out.alpha_composite(layer)
        dest = (round(ox - hx), round(oy - hy))
        if -sprite.size[0] < dest[0] < OUT_W and -sprite.size[1] < dest[1] < OUT_H:
            clip = Image.new("RGBA", out.size, (0, 0, 0, 0))
            clip.paste(sprite, dest)
            out.alpha_composite(clip)
        return out.convert("RGB")

    def render(self, target):
        frames = math.ceil(self.tl["duration"] * FPS)
        ffmpeg = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{OUT_W}x{OUT_H}", "-r", str(FPS), "-i", "-",
                                   "-c:v", "libx264", "-preset", "veryslow", "-tune", "animation", "-crf", os.environ.get("CRF", "22"), "-pix_fmt", "yuv420p", "-movflags", "+faststart", target],
                                  stdin=subprocess.PIPE)
        for n in range(frames):
            ffmpeg.stdin.write(self.frame(n / FPS).tobytes())
        ffmpeg.stdin.close()
        if ffmpeg.wait():
            sys.exit("ffmpeg failed")
        print(f"{target}: {frames / FPS:.1f} s, {os.path.getsize(target) / 1e6:.2f} MB")


# The panel always has the keyboard in the sandbox, so its frame would be the accent colour throughout.
def neutral_border(im):
    background, accent, border = (20, 22, 24), (61, 174, 233), (42, 44, 46)
    px = im.load()
    w, h = im.size
    corner = 12 * SCALE
    def fix(x, y):
        p = px[x, y]
        amount = max(0.0, min(1.0, (p[2] - background[2]) / (accent[2] - background[2])))
        expected = [b + amount * (a - b) for a, b in zip(accent, background)]
        if sum((q - e) ** 2 for q, e in zip(p, expected)) <= 14 ** 2:
            px[x, y] = tuple(round(b + amount * (c - b)) for c, b in zip(border, background))
    for x in range(w):
        for y in (*range(SCALE), *range(h - SCALE, h)):
            fix(x, y)
    for y in range(h):
        for x in (*range(SCALE), *range(w - SCALE, w)):
            fix(x, y)
    for x0 in (0, w - corner):
        for y0 in (0, h - corner):
            for y in range(y0, y0 + corner):
                for x in range(x0, x0 + corner):
                    fix(x, y)


MOD = "/var/tmp/mmt/app/mods/mattermost"
# The demo has no websocket to echo a sent post back, so the copy posts it itself, as the server's event would.
ECHO = """    if (this.cfg.demo && path === "/posts" && method === "POST") {
      const post = { ...body, id: `sent-${Date.now()}`, user_id: this.me.id, create_at: Date.now(), update_at: Date.now(), edit_at: 0, delete_at: 0, type: "", reply_count: 0, metadata: {} };
      await this.onEvent({ event: "posted", data: { post: JSON.stringify(post) }, broadcast: { channel_id: body.channel_id } }, cx);
      this.redraw(cx);
      return post;
    }
"""


def prepare():
    def patch(name, change):
        path = os.path.join(MOD, name)
        with open(path) as f:
            before = f.read()
        after = change(before)
        if after == before:
            sys.exit(f"{name} has changed, so the recording's patch no longer applies")
        with open(path, "w") as f:
            f.write(after)
    # They only exercise highlighting.
    patch("demo/demo.js", lambda s: "".join(l for l in s.splitlines(True) if "Not your name" not in l and "someone who can't notify" not in l))
    hook = "    if (this.cfg.demo) return demoApi(path, method, body);\n"
    patch("main.js", lambda s: s.replace(hook, ECHO + hook) if s.count(hook) == 1 else s)


def main(args):
    if args == ["prepare"]:
        prepare()
    elif args[:1] == ["record"] and len(args) == 3:
        os.makedirs(args[2], exist_ok=True)
        r = Recorder(args[2])
        SCENARIOS[args[1]](r)
        r.save()
    elif args[:1] == ["render"] and len(args) == 3:
        Renderer(args[1]).render(args[2])
    else:
        sys.exit(__doc__)


main(sys.argv[1:])
