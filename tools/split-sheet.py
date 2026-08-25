"""Cuts a growth sheet into the six sprites prep-crops.py expects.

The generator draws all six ages of a plant on one sheet, because asking for
them one at a time gives six different plants. What it does not do is keep to a
layout: asked for two rows of three it has produced two rows of three, three
rows of two, and an uneven scatter, on three runs of the same prompt. Cutting on
a fixed grid therefore sliced drawings in half and handed the game a leaf.

So nothing is assumed. The sheet is reduced to "ink or paper", the blank rows
are found and used to split it into bands, each band is split the same way on
its blank columns, and what is left is the drawings in reading order.

    tools/split-sheet.py <name> [sheet.png]
"""
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
NEAR_WHITE = 244


def ink_mask(sheet):
    """The drawing itself, without the shadow it casts.

    A shadow is neutral and mid-toned; a plant is either black outline or
    saturated colour. Keeping only the second separates neighbours whose shadows
    overlap — and the shadow still comes along in the crop, because the padding
    reaches it.
    """
    a = np.asarray(sheet.convert("RGB")).astype(np.int16)
    high, low = a.max(axis=2), a.min(axis=2)
    return (high < 120) | ((high - low) > 40)


def drawings(sheet):
    """Every separate drawing on the sheet, in reading order.

    Splitting on blank rows and columns is not enough: asked for six plants in
    two rows the generator draws them close enough that leaves in the bottom row
    touch, and three of them came back as one blob 971 pixels wide. So the ink
    is labelled into connected pieces instead, and pieces are merged into
    drawings by how close they are — a leaf that has come away from its stem
    belongs to the plant it is sitting on, and a plant two hundred pixels away
    does not.
    """
    mask = ink_mask(sheet)
    labels, count = ndimage.label(mask, structure=np.ones((3, 3)))
    if not count:
        return [], None
    sizes = ndimage.sum(mask, labels, range(1, count + 1))
    pieces = []
    for i, (ys, xs) in enumerate(ndimage.find_objects(labels)):
        if sizes[i] < 400:          # a speck, not part of anything
            continue
        pieces.append({"box": [xs.start, ys.start, xs.stop, ys.stop], "size": sizes[i]})
    if not pieces:
        return [], None

    # A drawing is usually one piece of connected ink, but not always: a handful
    # of seeds is three or four separate blobs. Big pieces are therefore taken as
    # drawings in their own right and never joined to each other — their boxes
    # overlap, since a leaf reaches across its neighbour — while small ones are
    # gathered up by proximity, which is what makes the seeds one drawing.
    biggest = max(p["size"] for p in pieces)
    large = [p["box"] for p in pieces if p["size"] >= biggest * 0.15]
    small = [p["box"] for p in pieces if p["size"] < biggest * 0.15]

    NEAR = 60
    def close(a, b):
        return (a[0] - NEAR < b[2] and b[0] - NEAR < a[2]
                and a[1] - NEAR < b[3] and b[1] - NEAR < a[3])

    joined = True
    while joined:
        joined = False
        for i in range(len(small)):
            for j in range(i + 1, len(small)):
                if close(small[i], small[j]):
                    a, b = small[i], small[j]
                    small[i] = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                    small.pop(j)
                    joined = True
                    break
            if joined:
                break

    # A stray piece sitting on a big drawing belongs to it; one on its own is a
    # drawing of its own, which is what the seeds are.
    boxes = [list(b) for b in large]
    for s in small:
        touching = next((b for b in boxes if close(b, s)), None)
        if touching:
            touching[:] = [min(touching[0], s[0]), min(touching[1], s[1]),
                           max(touching[2], s[2]), max(touching[3], s[3])]
        else:
            boxes.append(s)

    # Reading order: down the sheet in bands, left to right inside each.
    boxes.sort(key=lambda b: b[1])
    rows, current = [], []
    for b in boxes:
        if current and b[1] > current[-1][3] - (current[-1][3] - current[-1][1]) * 0.4:
            rows.append(current); current = []
        current.append(b)
    if current:
        rows.append(current)
    ordered = []
    for row in rows:
        ordered.extend(sorted(row, key=lambda b: b[0]))
    return [tuple(b) for b in ordered], labels


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
    boxes, labels = drawings(sheet)
    print(f"found {len(boxes)} drawings on the sheet")
    if len(boxes) != 6:
        # Worth saying loudly: six stages is the contract, and a sheet with the
        # wrong number of drawings on it is a sheet to draw again, not to cut.
        for i, b in enumerate(boxes):
            print(f"  {i + 1}: {b[2] - b[0]}x{b[3] - b[1]} at {b[0]},{b[1]}")
        print("expected 6 — generate the sheet again rather than cutting this one")
        return 1

    out = ROOT / "generated"
    # A drawing is cropped to its own box with room for its shadow, and then
    # everything in that box belonging to somebody else is painted back to
    # paper. Two things had to be got right for that to work.
    #
    # First, a piece of ink that appears inside two boxes — a leaf reaching
    # across a neighbour — belongs to whichever drawing holds most of it, not to
    # whichever was considered last. Deciding it by last-look left every crop
    # with a stranger's leaf in the corner.
    #
    # Second, shadows are not ink and so are not labelled at all, which left
    # neighbours' shadows lying in the crop as pale ellipses. A shadow belongs to
    # whatever is standing on it, so grey is kept only directly below this
    # drawing and cleared everywhere else.
    pad = 30
    owner = np.zeros(labels.max() + 1, dtype=np.int32)
    for tag in range(1, labels.max() + 1):
        ys, xs = np.where(labels == tag)
        if not len(xs):
            continue
        best, most = 0, 0
        for stage, (x0, y0, x1, y1) in enumerate(boxes, start=1):
            inside = int(np.count_nonzero((xs >= x0) & (xs < x1) & (ys >= y0) & (ys < y1)))
            if inside > most:
                best, most = stage, inside
        owner[tag] = best

    rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.int16)
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    greyish = (high - low <= 40) & (high < 244) & (high >= 120)

    for stage, (x0, y0, x1, y1) in enumerate(boxes, start=1):
        left, top = max(0, x0 - pad), max(0, y0 - pad)
        right, bottom = min(sheet.width, x1 + pad), min(sheet.height, y1 + pad)
        art = np.array(sheet.crop((left, top, right, bottom)))

        tags = labels[top:bottom, left:right]
        mine = np.isin(tags, np.where(owner == stage)[0]) & (tags != 0)
        # The shadow this one casts: grey, under its own width.
        under = np.zeros_like(mine)
        under[:, max(0, x0 - left):max(0, x1 - left)] = True
        shadow = greyish[top:bottom, left:right] & under
        # Keep this drawing and the shadow under it; everything else in the box
        # is paper. Clearing only what is labelled left the odd speck and the
        # pale rim of a neighbour's shadow behind, since neither is ink.
        #
        # The mask is grown a little first: it was built from a hard ink
        # threshold, so the soft pixels along this drawing's own outline are not
        # in it, and clearing them would file the edge flat.
        keep = ndimage.binary_dilation(mine, iterations=3) | shadow
        art[~keep] = (255, 255, 255, 255)

        Image.fromarray(art).save(out / f"crop-{name}-{stage}.png")
        print(f"  stage {stage}: {right - left}x{bottom - top}")
    print(f"wrote 6 stages to generated/crop-{name}-*.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
