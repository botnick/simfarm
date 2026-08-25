"""Turns generated product art into game-ready sprites.

The generator returns a centred object on flat white, and lifting it off that
paper is two questions, not one: which pixels are paper, and how sharply does
the drawing stop.

A flood fill from the edges answers the first perfectly. Only white joined to
the border is paper; white enclosed by the drawing — wool, a duck's body, milk
in a bottle — is never reached, so it survives. What it cannot answer is the
second: it is a yes-or-no test, so the edge it leaves is a stair of hard
pixels, and a cartoon outline drawn with a soft brush comes out jagged.

A cutout model answers the second and is the better tool for it, but which
model matters more than whether. `u2net`, the default and the one this was
first tried with, ate a third of the white sheep. `isnet-general-use` was worse
— it left the outline and legs and made the body see-through. `birefnet-general`
keeps exactly what the flood keeps, with a smooth edge, and only gets confused
where white wool meets white paper, leaving a faint grey haze there.

So both, each for what it is good at: the model draws the edge, and the flood
overrules it wherever it is certain the pixel was paper. Measured on the sheep
that started all this — 24.3% of the sheet kept either way, 2,000 pixels of
soft edge the flood could not have made, and 2,049 pixels of haze the model
could not have known were paper.
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
MODEL = "birefnet-general"   # the one that does not eat a white sheep
HAZE = 200          # below this, over paper, the model is guessing rather than seeing


_session = None


def _model():
    """Loaded once and kept: the first call fetches about a gigabyte."""
    global _session
    if _session is None:
        from rembg import new_session
        _session = new_session(MODEL)
    return _session


def soft_alpha(img: Image.Image) -> Image.Image | None:
    """What the cutout model makes of the edge, or None if it is not installed."""
    try:
        from rembg import remove
    except ImportError:
        return None
    return remove(img.convert("RGBA"), session=_model()).getchannel("A")


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

    # The flood has decided what is paper. Ask the model how the edge should
    # look, and take its answer everywhere the flood is not certain otherwise.
    hard = img.getchannel("A")
    soft = soft_alpha(img)
    if soft is None:
        # No model installed: the old behaviour, a blurred hard edge. Jagged,
        # but a sprite rather than nothing.
        img.putalpha(hard.filter(ImageFilter.GaussianBlur(0.6)))
        return img

    hard_px, soft_px = hard.load(), soft.load()
    merged = Image.new("L", img.size)
    out = merged.load()
    for y in range(h):
        for x in range(w):
            a = soft_px[x, y]
            # Where the flood found paper and the model is only half sure, the
            # flood wins — that is the haze where white meets white. Where the
            # model is confident, it wins, and the edge keeps its softness.
            out[x, y] = 0 if (hard_px[x, y] == 0 and a < HAZE) else a
    img.putalpha(merged)
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
