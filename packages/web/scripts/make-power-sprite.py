#!/usr/bin/env python3
"""make-power-sprite.py — the pet's fifth skin: 力量形态 (the grown form).

Source      : assets/power.png (用户 2026-11-05 提供的「长大之后」形象，
              1254×1254，全幅构图：翼撑到画布边缘)。原稿原样入库作为唯一
              输入源；换稿直接覆盖本文件重跑即可。
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

Pipeline (lineage: make-logo-sprite.py ω99-111; 2026-11-05 重做边缘——
用户反馈「透明背景下边缘还有不少像素毛刺」「还是不行，边界脏兮兮的」，
并追问「原图不是透明背景的吗，咋出这个问题」。病根三条，全部就地修：
  (a) 旧版把导出画布初始化成 (0,0,0,0)——零 alpha 底下藏着纯黑 RGB，
      非预乘 LANCZOS 一缩就把黑吸进边缘一圈（暗底上那圈脏边就是它）。
      现在透明区的 RGB 全部用最近可见像素填充（距离场式 BFS），
      缩放在任何底色下都不再引入外来颜色。
  (b) 旧版 alpha 是二值（0/255）+ ERODE 2px，本质是「砍掉一圈再硬切」，
      边缘没有覆盖率的斜坡，暗底上就是一排锯齿。现在 alpha 由反混解出的
      连续覆盖率给出（见 c），抗锯齿由求解本身给出，不再靠腐蚀。
  (c) **背景是一张画进像素里的棋盘格，不是白底**——那张「透明格子」是
      贴图惯例，PNG 本身没有 alpha 通道（`file` 报 8-bit RGB）。两档灰阶
      ≈ 252 / 212，周期 ≈ 10.9px，且完全无彩（chroma ≤ 6）；而画稿的每个
      像素都有色——连最外侧抗锯齿边都是 chroma 16~29，内部 ≥40。旧版按
      「通道 ≥225 即白」判背景，灰色那半边格子被判成画稿并吞进主体，于是
      每两个格子里就有一个格子的灰留在轮廓上——这才是「边界脏兮兮」的
      真身（改前实测：26.0% 的轮廓像素落在 198..240 的灰带里）。
      现在背景 = 无彩双色调泛洪；覆盖率是按**局部格子色**反混：
          cov = <W − c, W − f> / |W − f|²     （W = 该像素所在格子的灰阶）
      再用深度场兜住纯白/纯灰处退化的除法。导出的是画稿自己的颜色。

  1. 背景：无彩（chroma ≤ CHROMA_MAX）+ 够亮（lum ≥ LUM_MIN）的像素从画布
     四边 8 连通泛洪；小于 DESPECKLE_MIN 的封闭碎块（纹理、噪点）归回主体。
  2. 覆盖率：按局部格子色反混（上式）；深度 > DEEP 的像素强制 1.0，
     避免被内部纯白高光误判。
  3. RGB = 原稿反混后的颜色，透明区用最近可见像素填补。
  4. 缩放后贴到 1:1 方形画布（96%），sheet = frame|frame，README 图 512。

Self-checks (exit non-zero on any failure): the sheet is exactly two
frames; the two frames are pixel-identical (the no-blink contract); every
frame's corners are transparent; no isolated opaque floater; the outline
carries no leftover checkerboard grey; byte budget.

Requires Pillow (developed against 10.4.0). Pure Python — no numpy/scipy.
"""

from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image

# The source's "transparent" background is a BAKED checkerboard: two
# achromatic tones (~252 / ~212) on a ~10.9 px grid. It has to be separated
# by chroma, not brightness — see the docstring's (c).
CHROMA_MAX = 6       # bg is achromatic; every art pixel, even the
                     # anti-aliased outermost one, carries chroma >= 16
LUM_MIN = 190        # ...and the checker's darker tone is ~212, never below
CHECKER_LIGHT = 252.0
CHECKER_DARK = 212.0
CHECKER_PERIOD = 10.88
CHECKER_PHASE = (10.5, 10.25)
DEEP = 6             # px inside the figure — beyond the 1 px anti-alias ramp

# despeckle: blobs smaller than this (at the 1254×1254 source scale) are
# noise, not art. The main figure is ~1M px; nothing hand-drawn lives under
# a few thousand at that scale.
DESPECKLE_MIN = 3000

# frame geometry: full-canvas 1:1 (see docstring step 3)
FRAME = 272          # the sheet frame (2.8× the 96px pet display — the v2 art is denser than v1; 352→247KB, 288→174KB)
FIGURE = 512         # the README figure
MAX_BYTES = 160 * 1024  # the slime budget ×2 — the grown figure carries
                        # ~2.6× a slime frame's pixels at the same 4× headroom

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "..", "assets", "power.png")
PET_DIR = os.path.join(HERE, "..", "public", "pet")
ASSETS_DIR = os.path.join(HERE, "..", "..", "..", "assets")

N4 = ((1, 0), (-1, 0), (0, 1), (0, -1))
N8 = N4 + ((1, 1), (1, -1), (-1, 1), (-1, -1))


def classify(px, w: int, h: int):
    """Per-pixel luminance + chroma. Background is the achromatic, bright set."""
    lum = [0.0] * (w * h)
    chroma = [0] * (w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            r, g, b = px[x, y]
            hi = r if r > g else g
            if b > hi:
                hi = b
            lo = r if r < g else g
            if b < lo:
                lo = b
            i = base + x
            lum[i] = (r + g + b) / 3.0
            chroma[i] = hi - lo
    return lum, chroma


def background(lum, chroma, w: int, h: int) -> bytearray:
    """Outside-in 8-connected flood over achromatic bright px; enclosed
    specks under DESPECKLE_MIN are folded back into the figure."""
    def is_bg(i) -> bool:
        return chroma[i] <= CHROMA_MAX and lum[i] >= LUM_MIN

    bg = bytearray(w * h)
    q: deque[int] = deque()
    for x in range(w):
        for y in (0, h - 1):
            i = y * w + x
            if not bg[i] and is_bg(i):
                bg[i] = 1
                q.append(i)
    for y in range(h):
        for x in (0, w - 1):
            i = y * w + x
            if not bg[i] and is_bg(i):
                bg[i] = 1
                q.append(i)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        for dx, dy in N8:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if not bg[j] and is_bg(j):
                    bg[j] = 1
                    q.append(j)

    # enclosed achromatic blobs small enough to be texture → back to the figure
    seen = bytearray(w * h)
    for i0 in range(w * h):
        if not bg[i0] or seen[i0]:
            continue
        comp = []
        seen[i0] = 1
        q.append(i0)
        while q:
            i = q.popleft()
            comp.append(i)
            x, y = i % w, i // w
            for dx, dy in N4:
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h:
                    j = ny * w + nx
                    if bg[j] and not seen[j]:
                        seen[j] = 1
                        q.append(j)
        if len(comp) < DESPECKLE_MIN:
            for i in comp:
                bg[i] = 0
    return bg


def depth_from_bg(bg: bytearray, w: int, h: int) -> list[int]:
    """4-connected BFS distance from the background (0 = background)."""
    INF = 1 << 30
    d = [INF] * (w * h)
    q: deque[int] = deque()
    for i in range(w * h):
        if bg[i]:
            d[i] = 0
            q.append(i)
    while q:
        i = q.popleft()
        x, y = i % w, i // w
        nd = d[i] + 1
        for dx, dy in N4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if d[j] > nd:
                    d[j] = nd
                    q.append(j)
    return d


def nearest_deep_colour(px, d, chroma, w: int, h: int):
    """Foreground reference colour per pixel: the nearest px that is deep
    inside the figure AND genuinely chromatic (art, not leftover backdrop).
    A multi-source BFS gives every pixel its nearest such seed."""
    src = [0] * (w * h)          # 0 = unknown
    q: deque[int] = deque()
    for i in range(w * h):
        if d[i] > DEEP and chroma[i] >= 25:
            src[i] = i + 1
            q.append(i)
    if not q:
        raise SystemExit("FAIL: no deep chromatic seed — the figure vanished?")
    while q:
        i = q.popleft()
        s = src[i]
        x, y = i % w, i // w
        for dx, dy in N4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h:
                j = ny * w + nx
                if not src[j]:
                    src[j] = s
                    q.append(j)
    return [px[(s - 1) % w, (s - 1) // w] for s in src]


def checker_tone(x: int, y: int) -> float:
    """The backdrop grey under (x, y) — the baked checkerboard's own tone."""
    p = CHECKER_PERIOD
    cx = int((x - CHECKER_PHASE[0]) // p)
    cy = int((y - CHECKER_PHASE[1]) // p)
    return CHECKER_LIGHT if (cx + cy) % 2 == 0 else CHECKER_DARK


def solve(px, lum, chroma, d, ref, w: int, h: int):
    """Continuous coverage + the artwork's own colour, per source pixel."""
    cov = [0.0] * (w * h)
    out = [(0, 0, 0)] * (w * h)
    for y in range(h):
        base = y * w
        for x in range(w):
            i = base + x
            if d[i] == 0:
                continue
            if d[i] > DEEP:
                cov[i] = 1.0
            else:
                r, g, b = px[x, y]
                W = checker_tone(x, y)
                fr, fg, fb = ref[i]
                dr, dg, db = W - fr, W - fg, W - fb
                den = dr * dr + dg * dg + db * db
                if den > 2000.0:      # the colour is far enough from the
                                      # backdrop for the division to mean sth
                    c = ((W - r) * dr + (W - g) * dg + (W - b) * db) / den
                else:                 # near-neutral art: fall back to the
                                      # geometric ramp (1 px anti-alias)
                    c = d[i] / 1.5
                cov[i] = 0.0 if c < 0.0 else (1.0 if c > 1.0 else c)
            a = cov[i]
            if a < 0.004:
                continue
            r, g, b = px[x, y]
            W = checker_tone(x, y)
            k = 1.0 / a
            rr = (r - W * (1.0 - a)) * k
            gg = (g - W * (1.0 - a)) * k
            bb = (b - W * (1.0 - a)) * k
            out[i] = (0 if rr < 0 else (255 if rr > 255 else int(rr + 0.5)),
                      0 if gg < 0 else (255 if gg > 255 else int(gg + 0.5)),
                      0 if bb < 0 else (255 if bb > 255 else int(bb + 0.5)))
    return cov, out


def render(cov, colour, size: int) -> Image.Image:
    """alpha = BOX(coverage); RGB = the unmixed source colour, extended under
    every transparent px so no resampling ever pulls foreign colour in."""
    w, h = len(cov), 0
    # the coverage/colour arrays are square at source resolution
    n = int(len(cov) ** 0.5)
    alpha = Image.frombytes("L", (n, n), bytes(min(255, int(c * 255.0 + 0.5)) for c in cov))
    alpha = alpha.resize((size, size), Image.BOX)
    colour_img = Image.frombytes("RGB", (n, n), bytes(v for c in colour for v in c))
    colour_img = colour_img.resize((size, size), Image.LANCZOS)

    ap, cp = alpha.load(), colour_img.load()
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    op = out.load()
    known = bytearray(size * size)
    for y in range(size):
        for x in range(size):
            av = ap[x, y]
            if av == 0:
                continue
            r, g, b = cp[x, y]
            op[x, y] = (r, g, b, av)
            known[y * size + x] = 1

    # wavefront from every known pixel outward: nearest visible colour under
    # alpha 0. A full transparent page of (0,0,0,0) is what made the old
    # export pull black into the rim on a dark ground.
    q: deque[tuple[int, int]] = deque()
    for y in range(size):
        for x in range(size):
            if known[y * size + x]:
                for dx, dy in N4:
                    nx, ny = x + dx, y + dy
                    if 0 <= nx < size and 0 <= ny < size and not known[ny * size + nx]:
                        q.append((nx, ny))
    while q:
        x, y = q.popleft()
        i = y * size + x
        if known[i]:
            continue
        pick = None
        for dx, dy in N4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < size and 0 <= ny < size and known[ny * size + nx]:
                pick = op[nx, ny]
                break
        if pick is None:
            continue
        op[x, y] = (pick[0], pick[1], pick[2], 0)
        known[i] = 1
        for dx, dy in N4:
            nx, ny = x + dx, y + dy
            if 0 <= nx < size and 0 <= ny < size and not known[ny * size + nx]:
                q.append((nx, ny))
    return out


def corners_transparent(frame: Image.Image) -> bool:
    w, h = frame.size
    px = frame.load()
    return all(px[x, y][3] == 0 for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))


def main() -> int:
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    print(f"source: {w}x{h} mode=RGB (the 'transparent' grid is baked pixels)")
    px = im.load()

    lum, chroma = classify(px, w, h)
    bg = background(lum, chroma, w, h)
    kept = (w * h) - sum(bg)
    print(f"figure = {kept} px ({100.0 * kept / (w * h):.1f}%)")

    if kept < 400 * 400:
        print("FAIL: surviving figure suspiciously small — knockout ate the subject?", file=sys.stderr)
        return 1

    d = depth_from_bg(bg, w, h)
    ref = nearest_deep_colour(px, d, chroma, w, h)
    cov, colour = solve(px, lum, chroma, d, ref, w, h)

    # step 2+3: render at 96% of each canvas, then centre on transparent air
    inner = round(FRAME * 0.96)
    fig_inner = round(FIGURE * 0.96)
    frame = Image.new("RGBA", (FRAME, FRAME), (0, 0, 0, 0))
    frame.paste(render(cov, colour, inner), ((FRAME - inner) // 2, (FRAME - inner) // 2))
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
    figure = Image.new("RGBA", (FIGURE, FIGURE), (0, 0, 0, 0))
    figure.paste(render(cov, colour, fig_inner),
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
    # 都是漏网噪点。贴着形体的碎片不算：羽丝尖端在缩放后从主体断开，
    # 是艺术细节不是噪声。
    f_check = loaded.crop((0, 0, FRAME, FRAME))
    fp = f_check.load()
    seen_b = bytearray(FRAME * FRAME)
    boxes: list[tuple[int, int, int, int, int]] = []  # (n, x0, y0, x1, y1)
    for yy in range(FRAME):
        for xx in range(FRAME):
            if fp[xx, yy][3] > 0 and not seen_b[yy * FRAME + xx]:
                q = deque([(xx, yy)])
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
    main_box = max(boxes, key=lambda b: b[0])
    floaters = []
    for n, x0, y0, x1, y1 in boxes:
        dx = max(main_box[1] - x1, x0 - main_box[3], 0)
        dy = max(main_box[2] - y1, y0 - main_box[4], 0)
        if max(dx, dy) > 6:
            floaters.append((n, x0, y0, x1, y1))
    if floaters:
        print(f"FAIL: {len(floaters)} isolated opaque blobs (noise) far from the figure: {floaters[:5]}", file=sys.stderr)
        ok = False
    # 边缘自检：轮廓上不许再留棋盘格的灰（用户反复报的「边界脏兮兮」）。
    # 画稿本身每个像素都有色；chroma < 10 且亮度落在 195..240 的轮廓像素
    # 就是没解干净的格子灰。
    op_mask = [[fp[xx, yy][3] > 230 for xx in range(FRAME)] for yy in range(FRAME)]
    outline = dirty = 0
    for yy in range(1, FRAME - 1):
        for xx in range(1, FRAME - 1):
            if not op_mask[yy][xx]:
                continue
            if op_mask[yy - 1][xx] and op_mask[yy + 1][xx] and op_mask[yy][xx - 1] and op_mask[yy][xx + 1]:
                continue
            outline += 1
            r, g, b, _ = fp[xx, yy]
            ch = max(r, g, b) - min(r, g, b)
            lu = (r + g + b) / 3.0
            if ch < 10 and 195 < lu < 240:
                dirty += 1
    share = 100.0 * dirty / outline if outline else 0.0
    print(f"outline: {outline} px, checker-grey leftovers {dirty} px ({share:.2f}%)")
    if share > 2.0:
        print(f"FAIL: {share:.1f}% of the outline is leftover backdrop grey (budget 2%)", file=sys.stderr)
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
