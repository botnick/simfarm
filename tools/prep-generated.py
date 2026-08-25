"""Turns generated product art into game-ready sprites.

The generator returns a centred object on flat white. The obvious tool for
lifting it off that background is a saliency model like rembg, and it is the
wrong one: a white sheep on a white field is mostly white, so rembg ate the
wool and left a wire outline with legs.

What actually fits the input is a flood fill from the edges. Only white that is
connected to the border is background; white inside the drawing — wool, a
duck's body, the milk in a bottle — is never reached, so it survives.
"""
import sys
from collections import deque
from pathlib import Path

from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "generated"
OUT = ROOT / "game/public/assets/goods"
SIZE = 256          # plenty at the sizes the game draws these
MARGIN = 0.06       # breathing room so the outline is never flush to the edge
NEAR_WHITE = 236    # a pixel at least this bright on every channel counts as paper


def lift_background(img: Image.Image) -> Image.Image:
    """Clear the paper the drawing sits on, leaving anything enclosed by it."""
    img = img.convert("RGBA")
    w, h = img.size
    px = img.load()

    def is_paper(x, y):
        r, g, b, _ = px[x, y]
        return r >= NEAR_WHITE and g >= NEAR_WHITE and b >= NEAR_WHITE

    seen = bytearray(w * h)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_paper(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_paper(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        px[x, y] = (255, 255, 255, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_paper(nx, ny):
                seen[ny * w + nx] = 1
                queue.append((nx, ny))

    # The generator anti-aliases its outlines, so the last ring of pixels is a
    # blend of ink and paper. Softening the alpha edge stops it fringing white.
    alpha = img.getchannel("A").filter(ImageFilter.GaussianBlur(0.6))
    img.putalpha(alpha)
    return img


def main() -> int:
    # Named on the command line, only those are cut. Art arrives in batches and
    # redoing the whole folder every time hides which sprite actually changed.
    want = set(sys.argv[1:])
    files = [f for f in sorted(SRC.glob("*.png")) if not want or f.stem in want]
    if not files:
        print(f"nothing to cut in {SRC}" + (f" matching {sorted(want)}" if want else ""))
        return 1
    OUT.mkdir(parents=True, exist_ok=True)

    for f in files:
        cut = lift_background(Image.open(f))
        box = cut.getbbox()
        if box is None:
            print(f"  {f.name}: nothing left after the cutout, skipped")
            continue
        art = cut.crop(box)

        # Fit inside a square without distorting, keeping a small margin.
        inner = int(SIZE * (1 - MARGIN * 2))
        art.thumbnail((inner, inner), Image.LANCZOS)
        canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
        canvas.paste(art, ((SIZE - art.width) // 2, (SIZE - art.height) // 2), art)

        # How much of the drawing survived: a number worth seeing, because the
        # last approach silently deleted most of a sheep.
        opaque = sum(1 for a in canvas.getchannel("A").getdata() if a > 40)
        filled = opaque / (SIZE * SIZE)
        flag = "  <- suspiciously empty" if filled < 0.06 else ""
        dest = OUT / f.name
        canvas.save(dest, optimize=True)
        print(f"  {f.name:<20} {art.width}x{art.height}  {filled * 100:5.1f}% ink  {dest.stat().st_size // 1024} KB{flag}")

    print(f"\nwrote {len(files)} sprites to {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
