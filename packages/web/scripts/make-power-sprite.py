#!/usr/bin/env python3
"""make-power-sprite.py — the pet's fifth skin: 力量形态 (the grown form).

Source      : assets/power.png (用户 2026-11-05 提供、同日换稿——小精灵
              「长大之后」的形象，1254×1254 RGB 白底，银缘绿身全幅构图：
              银色轮廓/翼撑到画布边缘，白底只剩缝隙与四角)。原稿原样入库
              作为唯一输入源；换稿直接覆盖本文件重跑即可。
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
  4. Downscale to 272×272 (2.8× the pet's 96px display — retina headroom,
     same budget band as the slime sheets) with LANCZOS.
  5. Sheet: frame|frame side by side; the README figure at 512×512.

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

# despeckle: v2 source background texture — blobs smaller than this (at
# the 1254×1254 source scale) are noise, not art. The main figure is ~1M
# px; nothing hand-drawn lives under 2k.
DESPECKLE_MIN = 2000

# frame geometry: full-canvas 1:1 (see docstring step 3)
FRAME = 272          # the sheet frame (2.8× the 96px pet display — the v2 art is far denser than v1; 352→247KB, 288→174KB)
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


def despeckle(im: Image.Image) -> Image.Image:
    """Zero every connected opaque component under DESPECKLE_MIN px (the
    v2 background's off-white texture — step 2). 4-connectivity, source
    resolution; the figure is one component orders of magnitude larger."""
    w, h = im.size
    px = im.load()
    op = bytearray(w * h)
    for y in range(h):
        for x in range(w):
            if px[x, y][3] > 0:
                op[y * w + x] = 1
    seen = bytearray(w * h)
    from collections import deque as _dq
    for y0 in range(h):
        for x0 in range(w):
            if not op[y0 * w + x0] or seen[y0 * w + x0]:
                continue
            comp: list[tuple[int, int]] = []
            q = _dq([(x0, y0)])
            seen[y0 * w + x0] = 1
            while q:
                cx, cy = q.popleft()
                comp.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and op[ny * w + nx] and not seen[ny * w + nx]:
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            if len(comp) < DESPECKLE_MIN:
                for cx, cy in comp:
                    px[cx, cy] = (0, 0, 0, 0)
    return im


def corners_transparent(frame: Image.Image) -> bool:
    w, h = frame.size
    px = frame.load()
    return all(px[x, y][3] == 0 for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))


def main() -> int:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size
    print(f"source: {w}x{h}")

    knocked = despeckle(knockout(im))
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

    # step 2+3: scale the knocked-out figure onto the 1:1 frame at 96%
    # (full-bleed source has no air — the rim is synthesized here)
    inner = round(FRAME * 0.96)
    scaled = knocked.resize((inner, inner), Image.LANCZOS)
    frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    frame.paste(scaled, ((FRAME - inner) // 2, (FRAME - inner) // 2))
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
    fig_inner = round(FIGURE * 0.96)
    figure = Image.new("RGBA", (FIGURE, FIGURE), (0, 0, 0, 0))
    figure.paste(knocked.resize((fig_inner, fig_inner), Image.LANCZOS),
                 ((FIGURE - fig_inner) // 2, (FIGURE - fig_inner) // 2))
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
    # despeckle 自检：背景必须空——任何离主形体 bbox >6px 的不透明连通域
    # 都是漏网噪点（v2 修前：1,972 个 ≤76px 浮点）。贴着形体的碎片不算：
    # 羽丝尖端在 ÷4.6 缩放后从主体断开，是艺术细节不是噪声（实测 200 个
    # 全部贴合主形体 bbox ±1px）。
    f_check = loaded.crop((0, 0, FRAME, FRAME))
    fp = f_check.load()
    seen_b = bytearray(FRAME * FRAME)
    boxes: list[tuple[int, int, int, int, int]] = []  # (n, x0, y0, x1, y1)
    for yy in range(FRAME):
        for xx in range(FRAME):
            if fp[xx, yy][3] > 0 and not seen_b[yy * FRAME + xx]:
                from collections import deque as _dq2
                q = _dq2([(xx, yy)])
                seen_b[yy * FRAME + xx] = 1
                n = 0
                x0 = x1 = xx
                y0 = y1 = yy
                while q:
                    cx, cy = q.popleft()
                    n += 1
                    x0, x1 = min(x0, cx), max(x1, cx)
                    y0, y1 = min(y0, cy), max(y1, cy)
                    for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                        if 0 <= nx < FRAME and 0 <= ny < FRAME and fp[nx, ny][3] > 0 and not seen_b[ny * FRAME + nx]:
                            seen_b[ny * FRAME + nx] = 1
                            q.append((nx, ny))
                boxes.append((n, x0, y0, x1, y1))
    main = max(boxes, key=lambda b: b[0])
    floaters = []
    for n, x0, y0, x1, y1 in boxes:
        dx = max(main[1] - x1, x0 - main[3], 0)
        dy = max(main[2] - y1, y0 - main[4], 0)
        if max(dx, dy) > 6:
            floaters.append((n, x0, y0, x1, y1))
    if floaters:
        print(f"FAIL: {len(floaters)} isolated opaque blobs (noise) far from the figure: {floaters[:5]}", file=sys.stderr)
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
