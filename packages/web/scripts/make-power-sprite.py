#!/usr/bin/env python3
"""make-power-sprite.py — the pet's fifth skin: 力量形态 (the grown form).

Source      : assets/power.png (用户 2026-11-05 提供——小精灵「长大之后」的
              形象，1254×1254 RGB 白底)。这份原稿保持原样作为唯一输入源。
Outputs     : packages/web/public/pet/skin-power.png — 2-frame sheet
              (BOTH FRAMES IDENTICAL: the grown form is a single pose; the
              sheet keeps the 2-frame DOM contract so pet-blink simply
              flips between indistinguishable frames — zero visual delta,
              every state animation applies unchanged).
              assets/power-figure.png — the transparent figure alone
              (README-grade; the sheet itself would show both frames
              side by side in an <img>).

Reproduce (from anywhere; paths resolve relative to this file):
    python3 packages/web/scripts/make-power-sprite.py

Pipeline (lineage: make-logo-sprite.py ω99-111, tuning shared by intent —
the knockout constants are the family's, the eye synthesis is NOT: the
grown figure's dark-green design elements defeat the eye detector (20
candidates, the kept 2 are asymmetric design patches, not eyes), so the
closed-frame synthesis is deliberately absent — a bogus eye box would
deface the character. Duplicate-frame is the honest fallback):
  1. Knockout: flood near-white from the canvas edges → alpha 0; erode the
     silhouette 2px to kill the anti-aliased white↔green halo (same
     TOL/FLOOR/ERODE as the slime sheets).
  2. Frame = the FULL canvas (the 8%-margin crop of the slime script
     clamps to the canvas here — the bbox + margin overruns it), i.e. a
     clean 1:1 frame with the figure's own ~2.6% air. 1:1 keeps every
     consumer box square math exact (pet 96×96 root, hero 40×40 box).
  3. Downscale to 352×352 (3.7× the pet's 96px display — retina headroom,
     same budget band as the slime sheets) with LANCZOS.
  4. Sheet: frame|frame side by side; the README figure at 512×512.

Self-checks (exit non-zero on any failure): the sheet is exactly two
frames; the two frames are pixel-identical (the no-blink contract); every
frame's corners are transparent; byte budget.

Requires Pillow (developed against 10.4.0).
"""

from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image

# knockout — the family constants (make-logo-sprite.py ω99-108/111)
TOL = 30     # flood tolerance: near-white = channel >= 255-TOL
FLOOR = 16   # alpha below this = invisible rim → drop
ERODE = 2    # px shaved off the silhouette to kill the AA halo

# frame geometry: full-canvas 1:1 (see docstring step 2)
FRAME = 352          # the sheet frame (3.7× the 96px pet display — 384 overran the budget by 819B)
FIGURE = 512         # the README figure
MAX_BYTES = 160 * 1024  # the slime budget ×2 — the grown figure carries
                        # ~2.6× a slime frame's pixels at the same 4× headroom

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "..", "assets", "power.png")
PET_DIR = os.path.join(HERE, "..", "public", "pet")
ASSETS_DIR = os.path.join(HERE, "..", "..", "..", "assets")


def flood_background(px, w: int, h: int) -> bytearray:
    """Outside-in BFS over background-like pixels; 1-per-flooded-px."""
    def is_bg(c) -> bool:
        r, g, b, a = c
        return a == 0 or (r >= 255 - TOL and g >= 255 - TOL and b >= 255 - TOL)

    bg = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_bg(px[x, y]) and not bg[y * w + x]:
                bg[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_bg(px[x, y]) and not bg[y * w + x]:
                bg[y * w + x] = 1
                queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not bg[ny * w + nx] and is_bg(px[nx, ny]):
                bg[ny * w + nx] = 1
                queue.append((nx, ny))
    return bg


def knockout(im: Image.Image) -> Image.Image:
    """Flood + rim-floor + erosion, on a copy (the family recipe)."""
    w, h = im.size
    px = im.load()
    bg = flood_background(px, w, h)
    alpha = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            a = 0 if bg[y * w + x] else px[x, y][3]
            if 0 < a < FLOOR:
                a = 0
            alpha[y * w + x] = a
    for _ in range(ERODE):
        drop = []
        for y in range(h):
            for x in range(w):
                if not alpha[y * w + x]:
                    continue
                if any(
                    0 <= nx < w and 0 <= ny < h and alpha[ny * w + nx] == 0
                    for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1))
                ):
                    drop.append((x, y))
        for x, y in drop:
            alpha[y * w + x] = 0
    out = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    op = out.load()
    for y in range(h):
        for x in range(w):
            a = alpha[y * w + x]
            if a:
                op[x, y] = (*px[x, y][:3], a)
    return out


def corners_transparent(frame: Image.Image) -> bool:
    w, h = frame.size
    px = frame.load()
    return all(px[x, y][3] == 0 for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))


def main() -> int:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    print(f"source: {w}x{h}")

    knocked = knockout(im)
    bbox = knocked.getbbox()
    if bbox is None:
        print("FAIL: nothing survived the knockout (tolerance too wide?)", file=sys.stderr)
        return 1
    left, top, right, bottom = bbox
    bw, bh = right - left, bottom - top
    if bw < 100 or bh < 100:
        print("FAIL: surviving blob suspiciously small — knockout ate the subject?", file=sys.stderr)
        return 1
    print(f"figure bbox: {bw}x{bh} at ({left},{top}); frame = full {w}x{h} canvas (bbox+8% overruns)")

    # step 2: the frame IS the canvas (1:1); step 3: downscale
    frame = knocked.resize((FRAME, FRAME), Image.LANCZOS)
    if not corners_transparent(frame):
        print("FAIL: frame corners not transparent", file=sys.stderr)
        return 1

    # step 4: the sheet (frame|frame — identical by contract) + the figure
    sheet = Image.new("RGBA", (FRAME * 2, FRAME), (0, 0, 0, 0))
    sheet.paste(frame, (0, 0))
    sheet.paste(frame, (FRAME, 0))

    os.makedirs(PET_DIR, exist_ok=True)
    sheet_dst = os.path.join(PET_DIR, "skin-power.png")
    sheet.save(sheet_dst, optimize=True)
    figure = knocked.resize((FIGURE, FIGURE), Image.LANCZOS)
    os.makedirs(ASSETS_DIR, exist_ok=True)
    figure_dst = os.path.join(ASSETS_DIR, "power-figure.png")
    figure.save(figure_dst, optimize=True)
    s_size = os.path.getsize(sheet_dst)
    f_size = os.path.getsize(figure_dst)
    print(f"wrote skin-power.png: {s_size} bytes (budget {MAX_BYTES}); power-figure.png: {f_size} bytes")

    # ---- self-checks ------------------------------------------------------
    ok = True
    loaded = Image.open(sheet_dst).convert("RGBA")
    sw, sh = loaded.size
    if (sw, sh) != (FRAME * 2, FRAME):
        print(f"FAIL: sheet {sw}x{sh} is not two {FRAME}x{FRAME} frames", file=sys.stderr)
        ok = False
    f_open = loaded.crop((0, 0, FRAME, FRAME))
    f_closed = loaded.crop((FRAME, 0, FRAME * 2, sh))
    if list(f_open.getdata()) != list(f_closed.getdata()):
        print("FAIL: the two frames differ — the no-blink duplicate contract is broken", file=sys.stderr)
        ok = False
    for tag, f in (("open", f_open), ("closed", f_closed)):
        if not corners_transparent(f):
            print(f"FAIL: {tag} frame has opaque corners", file=sys.stderr)
            ok = False
    if s_size > MAX_BYTES:
        print(f"FAIL: over the {MAX_BYTES} budget", file=sys.stderr)
        ok = False
    if not ok:
        return 1
    print("all self-checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
