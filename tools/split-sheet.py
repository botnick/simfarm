"""Cuts a six-stage growth sheet into the six sprites prep-crops.py expects.

The generator draws all six ages of a plant on one sheet, because asking for
them one at a time gives six different plants. The sheet is two rows of three,
read left to right; this finds each drawing inside its cell rather than cutting
on a fixed grid, since the generator centres each one loosely.

    tools/split-sheet.py <name> [sheet.png]
"""
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
NEAR_WHITE = 244


def content_box(cell: Image.Image):
    """The drawing inside a cell, ignoring the paper around it."""
    grey = cell.convert("L").point(lambda p: 0 if p >= NEAR_WHITE else 255)
    return grey.getbbox()


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip())
        return 1
    name = sys.argv[1]
    src = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "generated" / f"{name}-sheet.png"
    if not src.exists():
        print(f"no sheet at {src}")
        return 1

    sheet = Image.open(src).convert("RGBA")
    w, h = sheet.size
    cw, ch = w // 3, h // 2
    out = ROOT / "generated"
    written = 0
    for stage in range(6):
        row, col = divmod(stage, 3)
        cell = sheet.crop((col * cw, row * ch, (col + 1) * cw, (row + 1) * ch))
        box = content_box(cell)
        if box is None:
            print(f"  stage {stage + 1}: the cell is empty, skipped")
            continue
        # A little air around the drawing so the cutter has paper to flood from.
        pad = 12
        box = (max(0, box[0] - pad), max(0, box[1] - pad),
               min(cw, box[2] + pad), min(ch, box[3] + pad))
        art = cell.crop(box)
        art.save(out / f"crop-{name}-{stage + 1}.png")
        print(f"  stage {stage + 1}: {art.width}x{art.height}")
        written += 1
    print(f"wrote {written} stages to generated/crop-{name}-*.png")
    return 0 if written == 6 else 1


if __name__ == "__main__":
    raise SystemExit(main())
