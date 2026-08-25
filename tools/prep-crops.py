"""Turns generated crop art into plot sprites.

The eight original crops came out of the SWF as one frame per stage, all six
sharing a single bounding box so the plant grows inside a fixed rectangle. The
plot draws them anchored at the foot, and nothing else in the scene rescales
them, so a generated crop has to arrive in that same box or it will be the
wrong size beside its neighbours and will hop as it grows.

Each crop is therefore cut, measured across all six stages at once, and scaled
by ONE factor so the six keep their relative sizes, then laid bottom-centre on
a canvas the size of the SWF crop it stands beside.
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "generated"
OUT = ROOT / "game/public/assets/crops"
STAGES = [1, 2, 3, 4, 5, 6]

# The SWF crop each new one stands beside, and the box that crop occupies. The
# SVGs are loaded at 1.6 x RENDER_SCALE, so the pixel box is the frame times
# that. Matching it is what keeps a radish the size of a turnip.
SCALE = 1.6 * 2
REFERENCE = {
    # The four added crops borrow the box of the SWF crop they most resemble.
    "radish":     (80.6, 58.55),    # turnip     — leafy root
    "sunflower":  (94.8, 108.55),   # corn       — tall single stalk
    "chili":      (81.7, 71.35),    # tomato     — bush
    "pumpkin":    (73.45, 57.7),    # watermelon — sprawling vine
    # The eight the game started with keep their own boxes, so a drawn
    # replacement lands exactly where the extracted one stood and nothing on the
    # field moves.
    "turnip":     (80.6, 58.55),
    "carrot":     (81.25, 43.3),
    "potato":     (86.95, 52.25),
    "tomato":     (81.7, 71.35),
    "corn":       (94.8, 108.55),
    "strawberry": (89.8, 48.25),
    "grape":      (85.4, 118.25),
    "watermelon": (73.45, 57.7),
}

NEAR_WHITE = 236

# The generator draws the ground shadow as a flat opaque grey. On brown soil
# that reads as a puddle, not a shadow — the SWF crops cast a translucent dark
# blob that darkens whatever it lies on. Anything neutral and mid-toned is that
# shadow (nothing else in these plants is grey), so it is repainted as black at
# the same weight the original art uses.
SHADOW_NEUTRAL = 20     # how far the channels may differ and still count as grey
SHADOW_RANGE = (70, 232)
SHADOW_ALPHA = 0.34


def soften_shadow(img: Image.Image) -> Image.Image:
    px = img.load()
    w, h = img.size
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if not a:
                continue
            if max(r, g, b) - min(r, g, b) > SHADOW_NEUTRAL:
                continue
            v = (r + g + b) // 3
            if not (SHADOW_RANGE[0] <= v <= SHADOW_RANGE[1]):
                continue
            # Lighter grey was a fainter part of the shadow; keep that falloff.
            weight = (SHADOW_RANGE[1] - v) / (SHADOW_RANGE[1] - SHADOW_RANGE[0])
            px[x, y] = (0, 0, 0, int(a * SHADOW_ALPHA * min(1.0, 0.45 + weight)))
    return img


def lift(img: Image.Image) -> Image.Image:
    """Clear the paper, leaving anything the drawing encloses. Flood from the edges."""
    from collections import deque
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_paper(x, y):
        r, g, b, _ = px[x, y]
        return r >= NEAR_WHITE and g >= NEAR_WHITE and b >= NEAR_WHITE

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_paper(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_paper(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_paper(nx, ny):
                seen[ny * w + nx] = 1
                q.append((nx, ny))

    out = img.copy()
    op = out.load()
    for y in range(h):
        row = y * w
        for x in range(w):
            if seen[row + x]:
                op[x, y] = (255, 255, 255, 0)
    return out


def main() -> int:
    want = set(sys.argv[1:]) or set(REFERENCE)
    unknown = want - set(REFERENCE)
    if unknown:
        print(f"no reference box for {sorted(unknown)}")
        return 1

    for crop in sorted(want):
        files = [SRC / f"crop-{crop}-{s}.png" for s in STAGES]
        missing = [f.name for f in files if not f.exists()]
        if missing:
            print(f"  {crop:<10} SKIPPED — missing {missing}")
            continue

        cuts = [soften_shadow(lift(Image.open(f))) for f in files]
        boxes = [c.getbbox() for c in cuts]
        if any(b is None for b in boxes):
            print(f"  {crop:<10} SKIPPED — a stage came out empty")
            continue

        # One box across all six, so one scale factor serves all of them and the
        # plant keeps its footing as it grows.
        left = min(b[0] for b in boxes)
        top = min(b[1] for b in boxes)
        right = max(b[2] for b in boxes)
        bottom = max(b[3] for b in boxes)
        uw, uh = right - left, bottom - top

        fw, fh = REFERENCE[crop]
        tw, th = round(fw * SCALE), round(fh * SCALE)
        factor = min(tw / uw, th / uh)

        for stage, cut in zip(STAGES, cuts):
            art = cut.crop((left, top, right, bottom))
            art = art.resize((max(1, round(uw * factor)), max(1, round(uh * factor))), Image.LANCZOS)
            canvas = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
            # Bottom-centre: the plot anchors the sprite at its foot.
            canvas.paste(art, ((tw - art.width) // 2, th - art.height), art)
            dest = OUT / crop / f"{stage}.png"
            dest.parent.mkdir(parents=True, exist_ok=True)
            canvas.save(dest, optimize=True)

        print(f"  {crop:<10} {tw}x{th}  from {uw}x{uh} at x{factor:.3f}  -> {OUT.relative_to(ROOT)}/{crop}/")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
