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
STAGES = 6       # a growth sheet always has exactly this many drawings on it
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

    # A drawing is usually one piece of connected ink, and sometimes several: a
    # handful of seeds is three or four blobs, and a withered plant sheds leaves
    # that touch nothing. Merging pieces by how close they are kept getting this
    # wrong in both directions — it split the seeds apart, and it swallowed a
    # dead plant into the ripe one standing beside it, so a tomato arrived in the
    # game with a corpse next to it.
    #
    # What is known for certain is the count: a growth sheet has six drawings on
    # it, no more and no less. So the pieces are grouped into exactly six by
    # where they sit, which needs no threshold and cannot merge two plants or
    # split one. Pieces are weighted by size, so a stray leaf joins the plant it
    # fell from rather than dragging a cluster towards itself.
    if len(pieces) < STAGES:
        return [], None
    centres = np.array([[(p["box"][0] + p["box"][2]) / 2, (p["box"][1] + p["box"][3]) / 2] for p in pieces])
    weights = np.array([p["size"] for p in pieces], dtype=float)

    # Start from six pieces spread across the sheet, not the six heaviest. The
    # heaviest can easily be two limbs of the same withered plant, which leaves
    # one drawing with two clusters and two other drawings sharing a third: the
    # seeds and the sprout came back in one cell that way, and a single fallen
    # leaf got a cell of its own. Taking the largest piece first and then
    # repeatedly the piece furthest from everything already chosen puts exactly
    # one seed on each drawing.
    seeds = [centres[int(np.argmax(weights))]]
    while len(seeds) < STAGES:
        away = ((centres[:, None, :] - np.array(seeds)[None, :, :]) ** 2).sum(axis=2).min(axis=1)
        seeds.append(centres[int(np.argmax(away * np.sqrt(weights)))])
    seeds = np.array(seeds, dtype=float)
    for _ in range(40):
        d = ((centres[:, None, :] - seeds[None, :, :]) ** 2).sum(axis=2)
        belongs = d.argmin(axis=1)
        moved = 0.0
        for k in range(STAGES):
            members = belongs == k
            if not members.any():
                continue
            w = weights[members][:, None]
            centre = (centres[members] * w).sum(axis=0) / w.sum()
            moved = max(moved, float(np.abs(centre - seeds[k]).max()))
            seeds[k] = centre
        if moved < 0.5:
            break

    boxes = []
    for k in range(STAGES):
        members = [pieces[i]["box"] for i in range(len(pieces)) if belongs[i] == k]
        if not members:
            return [], None
        boxes.append([min(b[0] for b in members), min(b[1] for b in members),
                      max(b[2] for b in members), max(b[3] for b in members)])

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
    #
    # Ownership goes by where a piece's middle is, not by how much of it happens
    # to fall inside a box. A leaf reaching across from the plant next door can
    # have most of its length inside this box while plainly belonging to the
    # other one; its middle never does. Counting pixels left a stray leaf beside
    # three of the eight crops.
    owner = np.zeros(labels.max() + 1, dtype=np.int32)
    centres = ndimage.center_of_mass(labels > 0, labels, range(1, labels.max() + 1))
    for tag, (cy, cx) in enumerate(centres, start=1):
        for stage, (x0, y0, x1, y1) in enumerate(boxes, start=1):
            if x0 <= cx < x1 and y0 <= cy < y1:
                owner[tag] = stage
                break

    rgb = np.asarray(Image.open(src).convert("RGB")).astype(np.int16)
    high, low = rgb.max(axis=2), rgb.min(axis=2)
    greyish = (high - low <= 40) & (high < 244) & (high >= 120)

    # Each sprite is built from its own pixels onto fresh paper, rather than cut
    # out of the sheet with a margin. Cutting with a margin kept pulling in the
    # neighbours: the drawings sit close enough that their boxes overlap, so
    # whatever rule decides who owns a piece — most pixels inside, or the middle
    # inside — there is a sheet where it gets one wrong, and a tomato arrives in
    # the game with a dead plant standing next to it. Copying only what belongs
    # to this drawing makes that impossible rather than unlikely.
    sheet_rgba = np.array(sheet)
    for stage, (x0, y0, x1, y1) in enumerate(boxes, start=1):
        mine = np.isin(labels, np.where(owner == stage)[0]) & (labels != 0)
        # The shadow it casts: grey, beneath its own width, within reach below.
        under = np.zeros_like(mine)
        under[y0:min(sheet.height, y1 + 60), x0:x1] = True
        keep = ndimage.binary_dilation(mine, iterations=3) | (greyish & under)
        if not keep.any():
            continue
        ys, xs = np.where(keep)
        top, bottom = ys.min(), ys.max() + 1
        left, right = xs.min(), xs.max() + 1

        pad = 12
        art = np.full((bottom - top + pad * 2, right - left + pad * 2, 4), 255, dtype=np.uint8)
        window = keep[top:bottom, left:right]
        art[pad:pad + (bottom - top), pad:pad + (right - left)][window] = \
            sheet_rgba[top:bottom, left:right][window]
        Image.fromarray(art).save(out / f"crop-{name}-{stage}.png")
        print(f"  stage {stage}: {art.shape[1]}x{art.shape[0]}")
    print(f"wrote 6 stages to generated/crop-{name}-*.png")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
