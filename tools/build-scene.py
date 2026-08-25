"""Assembles a scene backdrop from drawn pieces, at the coordinates the game
already expects.

A backdrop is not just a picture here. Every clickable thing in it is bound to
a rectangle in interaction-map.json — the farm has seven, for the four fields,
the coop, the house and the road to the village — and those rectangles are what
the game listens to. Ask a drawing model for "a farm" and it will put the house
wherever it likes; the house button then sits on empty grass and the game stops
answering.

So the pieces are drawn one at a time and placed here, each one fitted into the
rectangle its hotspot already occupies. The layout is inherited rather than
invented, which means the new art drops in without touching a single
coordinate, a test or a line of game code.

    tools/build-scene.py farm
"""
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PIECES = ROOT / "game/public/assets/goods"
OUT = ROOT / "game/public/assets/scenes"
MAPS = [ROOT / "game/public/data/interaction-map.json",
        ROOT / "game/public/data/interaction-map-ui.json"]
SIZE = (600, 420)          # the plates are exact renders of the original frames

# Which drawing stands in which hotspot, per scene. Anything not named here is
# scenery and is placed by hand below.
SCENES = {
    "farm": {
        "frame": 15,
        "ground": "scene-grass",
        "in": {
            "goto:house": "scene-house",
            "goto:coop": "scene-coop",
            "goto:village": "scene-road",
            "goto:field1": "prop-soil",
            "goto:field2": "prop-soil",
            "goto:field3": "prop-soil",
            "goto:field4": "prop-soil",
        },
        # Scenery, as (piece, centre x, centre y, width) in plate coordinates.
        "extras": [
            ("scene-fence", 40, 250, 90),
            ("scene-bush", 120, 300, 70),
            ("scene-tree", 560, 60, 110),
            ("scene-barrel", 60, 390, 60),
            ("scene-bush", 520, 380, 64),
        ],
    },
}


def regions(frame):
    """The same union-by-role the game does, so the pieces land where it clicks."""
    merged = {}
    for path in MAPS:
        if not path.exists():
            continue
        data = json.loads(path.read_text())
        for r in data.get("frame", {}).get(str(frame), []):
            merged[r["role"]] = r
    return merged


def fitted(name, width, height=None):
    """A piece scaled to fill a width, keeping its shape."""
    f = PIECES / f"{name}.png"
    if not f.exists():
        return None
    im = Image.open(f).convert("RGBA")
    scale = width / im.width
    if height is not None:
        scale = min(scale, height / im.height)
    return im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)


def ground(size):
    """A field of grass, tiled from a patch of the drawn scene.

    Asking for a full-bleed background does not work: this model draws objects
    on white, and told four different ways to fill the rectangle it returned a
    round green island on white three times out of four. What it does draw well
    is a scene — so a patch of clean grass is taken from one of those and tiled,
    which gives the same hand and covers the plate.
    """
    patch = ROOT / "generated/_plans/grass-patch.png"
    if not patch.exists():
        return Image.new("RGBA", size, (150, 200, 110, 255))
    tile = Image.open(patch).convert("RGBA")
    out = Image.new("RGBA", size)
    for y in range(0, size[1], tile.height):
        for x in range(0, size[0], tile.width):
            # Every other row and column flipped, so the seams do not line up
            # into a visible grid.
            t = tile
            if (x // tile.width) % 2:
                t = t.transpose(Image.FLIP_LEFT_RIGHT)
            if (y // tile.height) % 2:
                t = t.transpose(Image.FLIP_TOP_BOTTOM)
            out.alpha_composite(t, (x, y))
    return out


def build(name) -> int:
    spec = SCENES.get(name)
    if not spec:
        print(f"no recipe for {name}")
        return 1

    plate = ground(SIZE)
    where = regions(spec["frame"])
    placed = []
    # Far things first so near things overlap them, which is what a low camera
    # angle looks like.
    for role, piece in sorted(spec["in"].items(), key=lambda kv: where.get(kv[0], {}).get("y", 0)):
        r = where.get(role)
        if r is None:
            print(f"  {role}: no such hotspot, skipped")
            continue
        im = fitted(piece, r["w"], r["h"] * 1.35)
        if im is None:
            print(f"  {role}: missing piece {piece}")
            continue
        x = round(r["x"] + (r["w"] - im.width) / 2)
        y = round(r["y"] + r["h"] - im.height)
        plate.alpha_composite(im, (x, max(0, y)))
        placed.append(f"{role}->{piece}")

    for piece, cx, cy, w in spec.get("extras", []):
        im = fitted(piece, w)
        if im is None:
            continue
        plate.alpha_composite(im, (round(cx - im.width / 2), round(cy - im.height / 2)))

    OUT.mkdir(parents=True, exist_ok=True)
    plate.convert("RGB").save(OUT / f"{name}.png")
    print(f"  {name}: {', '.join(placed)}")
    print(f"wrote {OUT / f'{name}.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(build(sys.argv[1] if len(sys.argv) > 1 else "farm"))
