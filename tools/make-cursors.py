"""Cursor-sized copies of the tool art.

The original changed the mouse pointer to whatever the player was about to do —
a hand, a watering can, a bag of fertiliser, a spray bottle. Browsers will not
show a cursor larger than 128 pixels and quietly fall back to an arrow, so the
shipped art at 256 cannot be used directly.

Derived, not drawn: same source as the toolbar icons, so a redrawn tool changes
its cursor too.
"""
from PIL import Image
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "game/public/assets/goods"
OUT = ROOT / "game/public/assets/cursors"
SIZE = 44          # comfortably under the cap, and still legible on a phone

OUT.mkdir(parents=True, exist_ok=True)
made = 0
for src in sorted(SRC.glob("tool-*.png")):
    im = Image.open(src).convert("RGBA")
    # Trim first: the icons carry transparent margin, which would otherwise eat
    # most of the cursor and leave the drawing tiny.
    box = im.getbbox()
    if box:
        im = im.crop(box)
    im.thumbnail((SIZE, SIZE), Image.LANCZOS)
    pad = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    pad.paste(im, ((SIZE - im.width) // 2, (SIZE - im.height) // 2), im)
    pad.save(OUT / src.name.replace("tool-", "") )
    made += 1
print(f"{made} cursors -> {OUT.relative_to(ROOT)}")
