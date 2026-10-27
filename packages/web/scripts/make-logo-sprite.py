#!/usr/bin/env python3
"""make-logo-sprite.py — the pet's four skin sheets (ω99-111).

Source icon : apps/desktop/src-tauri/icons/icon.png (512x512 RGBA — the
              kawaii green slime on a white squircle, corners already
              transparent).
Outputs     : packages/web/public/pet/skin-{default,sakura,lake,honey}.png
              — one 2-frame sheet each (left = eyes open, right = eyes
              closed for the CSS pet-blink), served at /pet/ by vite
              publicDir and bundled by the tauri resources glob.

Reproduce (from anywhere; paths resolve relative to this file):
    python3 packages/web/scripts/make-logo-sprite.py

Pipeline:
  1. Knockout (ω99-108, unchanged): flood near-white from the canvas edges →
     alpha 0; drop the squircle's invisible rim (alpha < FLOOR); erode the
     silhouette ERODE px to kill the anti-aliased white↔green halo.
  2. Crop to the character bbox + 8% margin — the SAME geometry for every
     skin, so the character fills the 96px element instead of ~64% of it
     (the "looks static" root cause, brief §0) and all four sheets' frames
     are pixel-aligned.
  3. Eye detection on the knocked-out 512 canvas: mask = RGB distance ≤
     EYE_TOL from the sampled eye green → connected components → keep
     near-square (0.80 ≤ w/h ≤ 1.15) components 3-10% of canvas wide whose
     center sits in the top 55%. EXACTLY TWO must qualify (the smile is
     wider-than-tall and lower; the outline ring never forms a small blob).
     Not exactly two → hard error, NEVER a silently broken frame.
  4. Closed frame: each eye's ellipse filled with the LOCAL body color
     (median of the 3px ring around the eye — measured ≈ #90E131 where the
     eyes sit; the brief's flat #80D140 reads as a visible patch, the ring
     median IS "body color" at that spot) + a closed-eye arc "︶" in the
     eye's own green, stroke ≈ 12% of eye height.
  5. Skins: each frame is hue-rotated WHOLE (PIL HSV, H + const mod 256,
     S/V untouched — white highlights keep S=0 and stay white, alpha rides
     along untouched), so body/outline/blush/eyes shift as one family:
       sakura → pink, lake → blue, honey → orange-gold.
     The three deltas are pinned constants below (tuned once by eye).
  6. Sheet: open|closed side by side, saved optimized (budget ≤ 80KB each).

Self-checks (exit non-zero on any failure): every sheet is exactly two
frames; frame geometry identical across skins; the closed frame has no eye
residue inside the eye boxes (only the arc remains); every frame's corners
are transparent. The stale single-frame logo-sprite.png is removed — the
default sheet replaces it.

Requires Pillow (developed against 10.4.0).
"""

from __future__ import annotations

import os
import sys
from collections import deque

from PIL import Image, ImageDraw

# knockout (ω99-108, unchanged tuning)
TOL = 30     # flood tolerance: near-white = channel >= 255-TOL
FLOOR = 16   # alpha below this = the squircle's invisible rim → drop
ERODE = 2    # px shaved off the silhouette to kill the AA halo

# crop geometry: character bbox + 8% of bbox per side, same for all skins
MARGIN_FRAC = 0.08

# eye detection (canvas = the 512 source canvas)
EYE_GREEN = (20, 85, 22)   # sampled modal eye interior color (#145516)
EYE_TOL = 60               # RGB euclidean distance for the eye mask
EYE_MIN_PX = 200           # components smaller than this are noise, not eyes
EYE_AR_MIN = 0.80          # near-square: w/h ≥ this …
EYE_AR_MAX = 1.15          # … and ≤ this (the smile is 1.17 — excluded twice:
                           # the center-y rule below excludes it as well)
EYE_W_FRAC = (0.03, 0.10)  # eye width as a fraction of the canvas
EYE_CY_MAX = 0.55          # eye center in the top 55% of the canvas

# closed-eye drawing
ARC_W_FRAC = 0.70          # arc box width as a fraction of eye width
ARC_H_FRAC = 0.55          # arc box height as a fraction of eye height
ARC_STROKE_FRAC = 0.12     # stroke ≈ 12% of eye height (brief: 10-15%)
FILL_PAD = 2               # px pad on the eye bbox so the AA fringe dies too

# hue deltas (PIL H units, 0-255 ≙ 0-360°; body green sits at H≈62).
# Tuned once against a contact sheet; pinned so the skins are reproducible.
#   body green 87.6° → sakura ≈ 346° (cherry-blossom pink)
#                 → lake   ≈ 202° (lake blue)
#                 → honey  ≈ 38°  (orange-gold)
HUE_DELTA = {
    "sakura": 184,  # +258.8°: green → rose pink (Δ178 read hot-pink/crimson)
    "lake": 82,     # +115.3°: green → blue
    "honey": 220,   # −35.8° (256−36): green → orange-gold
}

MAX_BYTES = 80 * 1024

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "..", "apps", "desktop", "src-tauri", "icons", "icon.png")
PET_DIR = os.path.join(HERE, "..", "public", "pet")
SKINS = ("default", "sakura", "lake", "honey")


def flood_background(px, w: int, h: int) -> bytearray:
    """Outside-in BFS over background-like pixels; returns 1-per-flooded-px."""
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
    """Steps 1: flood + rim-floor + erosion, on a copy."""
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


def dist(c1, c2) -> float:
    return sum((a - b) ** 2 for a, b in zip(c1[:3], c2)) ** 0.5


def find_eyes(im: Image.Image) -> list[tuple[int, int, int, int]]:
    """Step 3: the two eyes as (x0, y0, x1, y1) bboxes, or raise.

    Exactly two qualifying components or the script dies — a bad blink frame
    must never ship silently (brief §2 asset rule).
    """
    w, h = im.size
    px = im.load()
    mask = [[dist(px[x, y], EYE_GREEN) <= EYE_TOL and px[x, y][3] > 200 for x in range(w)] for y in range(h)]

    seen = [[False] * w for _ in range(h)]
    boxes: list[tuple[int, int, int, int, int]] = []  # (x0,y0,x1,y1,px)
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            q: deque[tuple[int, int]] = deque([(x, y)])
            seen[y][x] = True
            n = 0
            x0 = x1 = x
            y0 = y1 = y
            while q:
                cx, cy = q.popleft()
                n += 1
                x0, x1 = min(x0, cx), max(x1, cx)
                y0, y1 = min(y0, cy), max(y1, cy)
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        q.append((nx, ny))
            if n >= EYE_MIN_PX:
                boxes.append((x0, y0, x1, y1, n))

    eyes: list[tuple[int, int, int, int]] = []
    rejects: list[str] = []
    for x0, y0, x1, y1, n in boxes:
        bw, bh = x1 - x0 + 1, y1 - y0 + 1
        ar = bw / bh
        wf = bw / w
        cyf = ((y0 + y1) / 2) / h
        why = []
        if not (EYE_AR_MIN <= ar <= EYE_AR_MAX):
            why.append(f"aspect {ar:.2f}")
        if not (EYE_W_FRAC[0] <= wf <= EYE_W_FRAC[1]):
            why.append(f"width {wf:.1%}")
        if cyf > EYE_CY_MAX:
            why.append(f"center-y {cyf:.1%}")
        if why:
            rejects.append(f"{bw}x{bh}@({x0},{y0}) [{n}px]: {', '.join(why)}")
        else:
            eyes.append((x0, y0, x1, y1))
    print(f"eye candidates: {len(boxes)} kept {len(eyes)}, rejected: {rejects or 'none'}")
    if len(eyes) != 2:
        print(f"FAIL: expected exactly 2 eyes, found {len(eyes)}", file=sys.stderr)
        raise SystemExit(1)
    return sorted(eyes, key=lambda b: b[0])


def ring_body_color(im: Image.Image, box: tuple[int, int, int, int]) -> tuple[int, int, int]:
    """The body color AT this eye: median of the opaque 3px ring around the
    eye bbox. The body is shaded (brighter up top); a flat fill would read
    as a patch, the ring median is invisible by construction."""
    w, h = im.size
    px = im.load()
    x0, y0, x1, y1 = box
    ring = []
    for y in range(max(0, y0 - 3), min(h, y1 + 4)):
        for x in range(max(0, x0 - 3), min(w, x1 + 4)):
            if x0 <= x <= x1 and y0 <= y <= y1:
                continue
            r, g, b, a = px[x, y]
            if a > 200:
                ring.append((r, g, b))
    if not ring:
        print(f"FAIL: no body pixels around eye {box}", file=sys.stderr)
        raise SystemExit(1)
    # per-channel median of the ring (sorted channel → middle element)
    channels = zip(*ring)
    return tuple(sorted(ch)[len(ch) // 2] for ch in channels)  # type: ignore[return-value]


def draw_closed_eyes(im: Image.Image, eyes: list[tuple[int, int, int, int]]) -> Image.Image:
    """Step 4: eyes-open frame → eyes-closed frame (fill + arc per eye)."""
    out = im.copy()
    d = ImageDraw.Draw(out)
    eye_rgb = EYE_GREEN
    for x0, y0, x1, y1 in eyes:
        ew, eh = x1 - x0 + 1, y1 - y0 + 1
        cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
        # 1. kill the eye: bbox + FILL_PAD px, filled with the LOCAL body color
        body = ring_body_color(out, (x0, y0, x1, y1))
        d.ellipse(
            (x0 - FILL_PAD, y0 - FILL_PAD, x1 + FILL_PAD, y1 + FILL_PAD),
            fill=(*body, 255),
        )
        # 2. the closed-eye arc "︶" (bottom half of an ellipse), eye's green
        aw, ah = round(ew * ARC_W_FRAC), round(eh * ARC_H_FRAC)
        box = (cx - aw // 2, cy - ah // 2, cx + aw // 2, cy + ah // 2)
        d.arc(box, start=0, end=180, fill=(*eye_rgb, 255), width=max(3, round(eh * ARC_STROKE_FRAC)))
    return out


def hue_shift(im: Image.Image, delta: int) -> Image.Image:
    """Step 5: rotate H by delta (PIL units, mod 256); S/V and alpha exact."""
    alpha = im.getchannel("A")
    hsv = im.convert("RGB").convert("HSV")
    h, s, v = hsv.split()
    h = h.point(lambda value: (value + delta) % 256)
    shifted = Image.merge("HSV", (h, s, v)).convert("RGB")
    shifted.putalpha(alpha)
    return shifted


def sheet(open_frame: Image.Image, closed_frame: Image.Image) -> Image.Image:
    """Step 6: two frames side by side — left open, right closed."""
    fw, fh = open_frame.size
    out = Image.new("RGBA", (fw * 2, fh), (0, 0, 0, 0))
    out.paste(open_frame, (0, 0))
    out.paste(closed_frame, (fw, 0))
    return out


def corners_transparent(frame: Image.Image) -> bool:
    w, h = frame.size
    px = frame.load()
    return all(px[x, y][3] == 0 for x, y in ((0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)))


def eye_residue(frame: Image.Image, box: tuple[int, int, int, int], eye_rgb: tuple[int, int, int]) -> int:
    """Pixels of THIS skin's eye color inside the eye box (eye before, arc
    after). The reference is the hue-shifted eye green — testing a shifted
    skin against the default green would vacuously read 0 (or, for honey,
    accidentally pass on a nearby olive)."""
    px = frame.load()
    n = 0
    for y in range(box[1], box[3] + 1):
        for x in range(box[0], box[2] + 1):
            if px[x, y][3] > 200 and dist(px[x, y], eye_rgb) <= EYE_TOL:
                n += 1
    return n


def shifted_eye_rgb(delta: int) -> tuple[int, int, int]:
    """The eye green through THIS skin's hue rotation (1x1 px, same codec)."""
    probe = Image.new("RGBA", (1, 1), (*EYE_GREEN, 255))
    return hue_shift(probe, delta).getpixel((0, 0))[:3]


def main() -> int:
    im = Image.open(SRC).convert("RGBA")
    w, h = im.size

    knocked = knockout(im)

    # step 3 runs on the 512 canvas (fractions are canvas-relative)
    eyes = find_eyes(knocked)

    # step 2: character bbox + 8% margin — the same crop for every skin
    bbox = knocked.getbbox()
    if bbox is None:
        print("FAIL: nothing survived the knockout (tolerance too wide?)", file=sys.stderr)
        return 1
    left, top, right, bottom = bbox
    bw, bh = right - left, bottom - top
    if bw < 100 or bh < 100:
        print("FAIL: surviving blob suspiciously small — knockout ate the subject?", file=sys.stderr)
        return 1
    mx, my = round(bw * MARGIN_FRAC), round(bh * MARGIN_FRAC)
    crop_box = (
        max(0, left - mx),
        max(0, top - my),
        min(w, right + mx),
        min(h, bottom + my),
    )
    open_frame = knocked.crop(crop_box)
    closed_frame = draw_closed_eyes(knocked, eyes).crop(crop_box)
    fw, fh = open_frame.size
    # eyes in crop coordinates for the per-frame self-checks
    eyes_c = [(x0 - crop_box[0], y0 - crop_box[1], x1 - crop_box[0], y1 - crop_box[1]) for x0, y0, x1, y1 in eyes]
    print(f"slime bbox: {bw}x{bh} at ({left},{top}); crop {fw}x{fh} (aspect {fw / fh:.3f})")

    os.makedirs(PET_DIR, exist_ok=True)
    ok = True
    for skin in SKINS:
        delta = 0 if skin == "default" else HUE_DELTA[skin]
        s_open = hue_shift(open_frame, delta)
        s_closed = hue_shift(closed_frame, delta)
        img = sheet(s_open, s_closed)
        dst = os.path.join(PET_DIR, f"skin-{skin}.png")
        img.save(dst, optimize=True)
        size = os.path.getsize(dst)
        print(f"wrote skin-{skin}.png: {size} bytes (budget {MAX_BYTES})")

        # ---- self-checks (brief §2 asset acceptance) ---------------------
        sheet_im = Image.open(dst).convert("RGBA")
        sw, sh_ = sheet_im.size
        if (sw, sh_) != (fw * 2, fh):
            print(f"FAIL skin-{skin}: sheet {sw}x{sh_} is not two {fw}x{fh} frames", file=sys.stderr)
            ok = False
        f_open = sheet_im.crop((0, 0, fw, fh))
        f_closed = sheet_im.crop((fw, 0, fw * 2, fh))
        eye_rgb = EYE_GREEN if delta == 0 else shifted_eye_rgb(delta)
        for tag, frame in (("open", f_open), ("closed", f_closed)):
            if not corners_transparent(frame):
                print(f"FAIL skin-{skin}: {tag} frame has opaque corners", file=sys.stderr)
                ok = False
        for eye in eyes_c:
            before = eye_residue(f_open, eye, eye_rgb)
            after = eye_residue(f_closed, eye, eye_rgb)
            # the open frame holds the eye (>500 mask px); the closed frame
            # holds only the arc (present, but ≲40% of the eye)
            if before < 500:
                print(f"FAIL skin-{skin}: open frame lost the eye at {eye} ({before}px)", file=sys.stderr)
                ok = False
            if not (0 < after <= before * 0.4):
                print(f"FAIL skin-{skin}: closed frame eye residue at {eye}: {after}px of {before}px", file=sys.stderr)
                ok = False
        if size > MAX_BYTES:
            print(f"FAIL skin-{skin}: over the 80KB asset budget", file=sys.stderr)
            ok = False

    # frame geometry identical across skins: hue_shift is pixel-aligned by
    # construction, but the check is cheap insurance — compare alpha bboxes.
    ref = None
    for skin in SKINS:
        im2 = Image.open(os.path.join(PET_DIR, f"skin-{skin}.png")).convert("RGBA")
        fw2, fh2 = im2.size
        geo = (im2.crop((0, 0, fw2 // 2, fh2)).getbbox(), im2.crop((fw2 // 2, 0, fw2, fh2)).getbbox())
        if ref is None:
            ref = geo
        elif geo != ref:
            print(f"FAIL skin-{skin}: frame geometry {geo} != {ref}", file=sys.stderr)
            ok = False

    # the single-frame asset this pipeline replaces — regenerable, not lost
    stale = os.path.join(PET_DIR, "logo-sprite.png")
    if os.path.exists(stale):
        os.remove(stale)
        print("removed stale logo-sprite.png (replaced by skin-default.png)")

    if not ok:
        return 1
    print("all self-checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
