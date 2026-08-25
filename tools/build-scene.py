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


def build(name) -> int:
    spec = SCENES.get(name)
    if not spec:
        print(f"no recipe for {name}")
        return 1

    ground = fitted(spec["ground"], SIZE[0] * 2)
    if ground is None:
        print(f"missing ground piece {spec['ground']}")
        return 1
    plate = Image.new("RGBA", SIZE, (255, 255, 255, 255))
    # Cover the plate with the ground, cropped from the middle so its edges do
    # not show.
    ground = ground.resize((SIZE[0], max(SIZE[1], round(ground.height * SIZE[0] / ground.width))), Image.LANCZOS)
    plate.alpha_composite(ground.crop((0, 0, SIZE[0], SIZE[1])), (0, 0))

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
        # Sat in the rectangle, standing on its floor: a house belongs at the
        # bottom of its hotspot, not floating in the middle of it.
        x = round(r["x"] + (r["w"] - im.width) / 2)
        y = round(r["y"] + r["h"] - im.height)
        plate.alpha_composite(im, (x, max(0, y)) if y >= 0 else (x, 0))
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
