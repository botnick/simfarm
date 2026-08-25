"""The plot plates — the screen the game is actually played on.

The twelve tiles are drawn on the exact centres their hotspots declare, and
they tile edge to edge: the hotspot boxes are 195x98 and step by (99,-50)
along a row and (98,51) to the next, which is the bounding box of a diamond
that meets its neighbours. Crops are placed on these same centres, so a tile
drawn anywhere else would grow its plant off the soil.
"""
import importlib.util as u, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = u.spec_from_file_location("painter", ROOT / "tools/paint-scene.py")
P = u.module_from_spec(spec); spec.loader.exec_module(P)

# Fields 1-2 and 3-4 lay their twelve tiles out differently — the second pair
# sits about 19 left and 14 down of the first. Painting one grid for all four
# would grow every plant on plots 3 and 4 off the edge of its soil.
TILES = {
    1: [(60, 223), (158, 173), (256, 122), (356, 71),
        (158, 275), (257, 224), (354, 174), (454, 122),
        (262, 324), (361, 274), (458, 223), (559, 172)],
    3: [(41, 237), (140, 187), (237, 136), (337, 85),
        (139, 288), (238, 238), (336, 187), (436, 136),
        (244, 338), (342, 287), (440, 237), (540, 185)],
}
TILES[2], TILES[4] = TILES[1], TILES[3]
# A hotspot box is 195x98, but the grid steps by (99,-50) and (98,51) — so the
# diamond that actually meets its neighbours is a shade wider than its box.
# Drawn at the box size the tiles leave green seams between them.
TW, TH = 199, 101

HUD_PLAQUE = (8, 10, 184, 70)        # money sits on this
ENERGY_BOX = (516.1, 13.25, 63.25, 43.65)
BAR = (138, 341, 453, 67)
# PlotScene draws no icons — it only puts a hit zone and a selection ring over
# the bar the plate paints, on these exact centres. A plate with empty slots
# leaves the player five blank white squares to choose between.
TOOL_X0, TOOL_DX, TOOL_Y = 169.75, 69.75, 368
TOOL_ORDER = ["harvest", "water", "fertilize", "spray", "clear"]
HOME = (547, 364)
PLANT_BTN = (45, 378, 30)            # the sow button, left of the bar

# Each plot dresses its edges differently; the grid underneath is the same.
DECOR = {
    1: [("fence", 44, 96), ("fence", 78, 108), ("bush", 138, 128), ("bush", 22, 186),
        ("tuft", 545, 262), ("tuft", 585, 330), ("barrel", 32, 330)],
    2: [("fence", 108, 78), ("fence", 142, 90), ("bush", 60, 40), ("bush", 420, 34),
        ("tuft", 528, 46), ("tuft", 580, 300), ("barrel", 32, 330)],
    3: [("fence", 268, 40), ("fence", 302, 52), ("bush", 470, 60), ("bush", 8, 300),
        ("tuft", 430, 44), ("tuft", 560, 92), ("barrel", 32, 330)],
    4: [("fence", 350, 44), ("fence", 384, 56), ("bush", 250, 30), ("bush", 566, 250),
        ("tuft", 40, 120), ("tuft", 200, 40), ("barrel", 32, 330)],
}
PIECE = {"fence": ("scene-fence", 48), "bush": ("scene-bush", 30),
         "barrel": ("scene-barrel", 46), "tree": ("scene-tree", 92)}


def tile(p, cx, cy):
    hw, hh = TW / 2, TH / 2
    p.poly([(cx, cy - hh), (cx + hw, cy), (cx, cy + hh), (cx - hw, cy)],
           P.EARTH_D, P.INK, 2)
    k = 0.86
    p.poly([(cx, cy - hh * k), (cx + hw * k, cy), (cx, cy + hh * k), (cx - hw * k, cy)],
           P.EARTH)
    p.blob(cx, cy + hh * 0.10, hw * 0.50, hh * 0.32, (181, 120, 71))   # the worked mound
    p.blob(cx + hw * 0.06, cy - hh * 0.02, hw * 0.30, hh * 0.17, (196, 136, 84))


def toolbar(p):
    x, y, w, h = BAR
    p.rounded((x, y, x + w, y + h), 16, P.INK)
    p.rounded((x + 3, y + 3, x + w - 3, y + h - 3), 14, (74, 140, 200))
    p.rounded((x + 8, y + 7, x + w - 8, y + h * 0.46), 9, (108, 176, 226))
    for i, tool in enumerate(TOOL_ORDER):
        slot(p, TOOL_X0 + i * TOOL_DX, TOOL_Y, f"tool-{tool}")
    slot(p, HOME[0], HOME[1], "scene-house", art_h=30)


def slot(p, cx, cy, art, s=25, art_h=34):
    p.rounded((cx - s, cy - s, cx + s, cy + s), 9, P.INK)
    p.rounded((cx - s + 2.5, cy - s + 2.5, cx + s - 2.5, cy + s - 2.5), 7, (250, 248, 240))
    p.paste(art, cx, cy + art_h / 2, art_h)


def paint(n):
    p = P.Plate()
    p.rolling([(120, 90, 190, 80, True), (470, 330, 180, 80, True),
               (60, 320, 130, 70, False), (520, 60, 150, 60, False)])
    for cx, cy in TILES[n]:
        tile(p, cx, cy)
    for kind, x, y in DECOR[n]:
        if kind == "tuft":
            p.tuft(x, y, 1.1)
        else:
            name, hgt = PIECE[kind]
            p.paste(name, x, y, hgt)
    # the money plaque and the heart badge, both painted into the frame
    P.hud_panel(p, HUD_PLAQUE)
    p.heart(ENERGY_BOX)
    # the sow button
    bx, by, br = PLANT_BTN
    p.blob(bx, by, br + 3, br + 3, P.INK)
    p.blob(bx, by, br, br, (74, 140, 200))
    p.blob(bx, by - br * 0.35, br * 0.72, br * 0.34, (108, 176, 226))
    p.tuft(bx, by + br * 0.5, 1.5)
    toolbar(p)
    out = ROOT / f"generated/scene-plot{n}.png"
    p.save(out)
    print("wrote", out)


for n in (1, 2, 3, 4):
    paint(n)
