"""Draws a layout plan for a scene, to hand to the drawing model as a guide.

Composing a backdrop out of finished sprites gives a collage: each piece carries
its own heavy outline and its own shadow, so they sit on the picture rather than
in it. Asking for a whole scene instead gives something that hangs together, but
the model puts the house wherever it likes — and every clickable thing here is
bound to a rectangle in interaction-map.json, so a house in the wrong place is a
house button on empty grass.

A plan solves both. This draws the rectangles the game already listens to as
flat labelled blocks, and that plan is handed over as the picture to paint from.
The model invents the art; the plan fixes where things go.

It is also drawn here rather than taken from the original game, which matters:
handing over the old backdrop as a guide would make the result a derivative of
it, which is the whole thing being avoided.

    tools/scene-plan.py farm
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MAPS = [ROOT / "game/public/data/interaction-map.json",
        ROOT / "game/public/data/interaction-map-ui.json"]
OUT = ROOT / "generated/_plans"
SIZE = (1024, 717)          # the plate's shape, drawn large for the model

PLANS = {
    "farm": {
        "frame": 15,
        "ground": (150, 200, 110),
        "blocks": {
            "goto:field1": ((120, 85, 55), "brown tilled field"),
            "goto:field2": ((120, 85, 55), "brown tilled field"),
            "goto:field3": ((120, 85, 55), "brown tilled field"),
            "goto:field4": ((120, 85, 55), "brown tilled field"),
            "goto:coop": ((200, 160, 90), "wooden hen house"),
            "goto:house": ((190, 110, 90), "farm cottage"),
            "goto:village": ((205, 175, 125), "dirt road leaving the farm"),
        },
    },
}


def regions(frame):
    merged = {}
    for path in MAPS:
        if not path.exists():
            continue
        for r in json.loads(path.read_text()).get("frame", {}).get(str(frame), []):
            merged[r["role"]] = r
    return merged


def build(name) -> int:
    plan = PLANS.get(name)
    if not plan:
        print(f"no plan for {name}")
        return 1
    sx, sy = SIZE[0] / 600, SIZE[1] / 420
    im = Image.new("RGB", SIZE, plan["ground"])
    d = ImageDraw.Draw(im)
    where = regions(plan["frame"])

    # A hotspot is a generous click target, not the shape of the thing in it:
    # the fields are diamonds and their rectangles are the boxes around them, so
    # drawn literally they overlap into one slab. Each block is therefore drawn
    # at the middle of its hotspot, smaller, in the shape the thing actually is.
    order = sorted(plan["blocks"], key=lambda r: where.get(r, {}).get("y", 0))
    for role in order:
        colour, _ = plan["blocks"][role]
        r = where.get(role)
        if r is None:
            print(f"  {role}: no such hotspot")
            continue
        cx, cy = (r["x"] + r["w"] / 2) * sx, (r["y"] + r["h"] / 2) * sy
        w, h = r["w"] * sx * 0.62, r["h"] * sy * 0.62
        if role.startswith("goto:field"):
            # A tilled plot, seen from the low angle the whole game is drawn at.
            d.polygon([(cx, cy - h / 2), (cx + w / 2, cy), (cx, cy + h / 2), (cx - w / 2, cy)],
                      fill=colour, outline=(70, 45, 30), width=5)
        elif role == "goto:village":
            d.ellipse([cx - w / 2, cy - h / 3, cx + w / 2, cy + h / 3], fill=colour, outline=(70, 45, 30), width=5)
        else:
            d.rounded_rectangle([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2],
                                radius=16, fill=colour, outline=(70, 45, 30), width=5)
    OUT.mkdir(parents=True, exist_ok=True)
    im.save(OUT / f"{name}.png")
    print(f"wrote {OUT / f'{name}.png'}  ({len(where)} hotspots)")
    return 0


if __name__ == "__main__":
    raise SystemExit(build(sys.argv[1] if len(sys.argv) > 1 else "farm"))
