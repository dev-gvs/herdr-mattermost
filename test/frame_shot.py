#!/usr/bin/env python3
"""Turns a sandbox screenshot into one for the repo: rounded corners on transparency and a border in the unfocused colour.

The panel always has the keyboard in the sandbox, so its frame would be the accent colour in every picture.

Usage: frame_shot.py IN.png OUT.png (needs Pillow)
"""
import sys
from PIL import Image, ImageDraw

RADIUS = 10
CORNER = RADIUS + 2
SUPERSAMPLE = 4
BACKGROUND = (20, 22, 24)
ACCENT = (61, 174, 233)
BORDER = (42, 44, 46)
# How far a pixel may stray from the background-to-accent line and still count as the border. An open dialog or
# viewer dims the frame enough to fall outside it, and those pixels stay as they are.
TOLERANCE = 14


def on_edge(x, y, w, h):
    if x == 0 or y == 0 or x == w - 1 or y == h - 1:
        return True
    return min(x, w - 1 - x) < CORNER and min(y, h - 1 - y) < CORNER


def recolor(pixel):
    amount = max(0.0, min(1.0, (pixel[2] - BACKGROUND[2]) / (ACCENT[2] - BACKGROUND[2])))
    expected = [b + amount * (a - b) for a, b in zip(ACCENT, BACKGROUND)]
    if sum((p - e) ** 2 for p, e in zip(pixel, expected)) > TOLERANCE ** 2:
        return pixel
    return tuple(round(b + amount * (c - b)) for c, b in zip(BORDER, BACKGROUND)) + (pixel[3],)


def main(source, target):
    im = Image.open(source).convert("RGBA")
    w, h = im.size
    px = im.load()
    for y in range(h):
        for x in range(w):
            if on_edge(x, y, w, h):
                px[x, y] = recolor(px[x, y])
    mask = Image.new("L", (w * SUPERSAMPLE, h * SUPERSAMPLE), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, w * SUPERSAMPLE - 1, h * SUPERSAMPLE - 1), RADIUS * SUPERSAMPLE, fill=255)
    im.putalpha(mask.resize((w, h), Image.LANCZOS))
    im.save(target, optimize=True)


main(*sys.argv[1:])
