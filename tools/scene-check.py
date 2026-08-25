"""Draws the game's hotspots over a candidate backdrop.

A backdrop can be beautiful and still be wrong: what matters is whether the
house is under the house button. This puts the rectangles the game actually
listens to on top of the picture, so the answer is visible rather than argued
about.

    tools/scene-check.py farm <candidate.png>
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
MAPS = [ROOT / "game/public/data/interaction-map.json",
        ROOT / "game/public/data/interaction-map-ui.json"]
PLATE = (600, 420)
FRAMES = {"farm": 15, "coop": 40, "shop": 55, "plot1": 20, "plot2": 25, "plot3": 30, "plot4": 35}


def regions(frame):
    merged = {}
    for path in MAPS:
        if not path.exists():
            continue
        for r in json.loads(path.read_text()).get("frame", {}).get(str(frame), []):
            merged[r["role"]] = r
    return merged


def fit(im):
    """The candidate as the plate will actually show it: filled and centre-cropped."""
    want = PLATE[0] / PLATE[1]
    have = im.width / im.height
    if have > want:
        w = round(im.height * want)
        im = im.crop(((im.width - w) // 2, 0, (im.width - w) // 2 + w, im.height))
    else:
        h = round(im.width / want)
        im = im.crop((0, (im.height - h) // 2, im.width, (im.height - h) // 2 + h))
    return im.resize(PLATE, Image.LANCZOS)


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip())
        return 1
    name, candidate = sys.argv[1], Path(sys.argv[2])
    frame = FRAMES.get(name)
    if frame is None:
        print(f"no frame known for {name}")
        return 1
    plate = fit(Image.open(candidate).convert("RGB")).resize((1200, 840), Image.NEAREST)
    d = ImageDraw.Draw(plate, "RGBA")
    for role, r in sorted(regions(frame).items()):
        box = [r["x"] * 2, r["y"] * 2, (r["x"] + r["w"]) * 2, (r["y"] + r["h"]) * 2]
        d.rectangle(box, outline=(255, 0, 0, 255), width=4)
        d.rectangle([box[0], box[1], box[0] + 210, box[1] + 30], fill=(255, 0, 0, 220))
        d.text((box[0] + 8, box[1] + 8), role, fill=(255, 255, 255, 255))
    out = ROOT / "game/shots" / f"check-{name}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    plate.save(out)
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
