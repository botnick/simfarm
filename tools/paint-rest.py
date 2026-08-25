"""The frames left over: the coop, the village, the two shop fronts, the menu.

How much of each plate the player ever sees varies a lot. The shops draw their
own cream panel over nearly the whole screen, so all that survives is the money
plaque and a border; the village and the menu are scenery end to end. Each is
painted to the geometry its frame declares either way.
"""
import importlib.util as u
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = u.spec_from_file_location("painter", ROOT / "tools/paint-scene.py")
P = u.module_from_spec(spec); spec.loader.exec_module(P)

ENERGY = (516.1, 13.25, 63.25, 43.65)
PLAQUE_TL = (8, 10, 184, 70)          # money reads at 34,42 on the coop and 44,45 in the shops
PLAQUE_BR = (414, 313, 178, 70)       # the village reads day at 439,345 and money at 440,371

WOOD = (165, 104, 60)
WOOD_D = (122, 76, 43)
FLOOR = (138, 92, 56)
FLOOR_D = (112, 73, 43)


def coop():
    """Frame 40. A barn floor with the feeder on its hotspot and the egg spots
    left clear, plus the three-slot bar the frame paints at the bottom right."""
    p = P.Plate(FLOOR)
    # back wall, then the floor in front of it
    p.rounded((-10, -10, 610, 128), 2, WOOD)
    for i in range(13):
        x = -10 + i * 48
        p.poly([(x, -10), (x + 6, -10), (x + 6, 126), (x, 126)], WOOD_D)
    p.poly([(-10, 118), (610, 118), (610, 430), (-10, 430)], FLOOR, P.INK, 2.5)
    for cx, cy, rx in ((120, 210, 90), (430, 300, 110), (260, 380, 95), (520, 160, 70)):
        p.blob(cx, cy, rx, rx * 0.34, FLOOR_D)
    # scattered straw
    for i, (x, y) in enumerate(((90, 170), (300, 210), (470, 250), (180, 300), (390, 360),
                                (540, 200), (60, 330), (250, 150), (430, 140), (140, 390))):
        p.poly([(x, y), (x + 11, y - 3), (x + 12, y + 1), (x + 1, y + 4)], (214, 178, 96), P.INK, 1.2)

    # the feeder, on the feed-chickens hotspot
    fx, fy = 388, 100
    p.poly([(fx - 118, fy + 52), (fx + 118, fy + 8), (fx + 118, fy + 52), (fx - 118, fy + 96)],
           (52, 104, 160), P.INK, 2.5)
    p.poly([(fx - 118, fy + 52), (fx + 118, fy + 8), (fx + 96, fy - 32), (fx - 140, fy + 12)],
           (74, 140, 200), P.INK, 2.5)
    for i in range(5):
        t = (i + 1) / 6
        ax, ay = fx - 140 + 236 * t, fy + 12 - 44 * t
        p.poly([(ax, ay), (ax + 22, ay - 4), (ax + 22, ay + 40), (ax, ay + 44)], (40, 84, 134))

    p.paste("scene-barrel", 70, 386, 56)          # the egg bin, on its hotspot
    P.hud_panel(p, PLAQUE_TL)
    bar(p, [("tool-harvest", 376, 353), ("supply-grain", 461, 353), ("scene-house", 547, 363)],
        (330, 326, 262, 74))
    return p


def village():
    """Frame 50. Two shop fronts and the road home, each on its hotspot."""
    p = P.Plate()
    p.rolling([(300, 120, 220, 90, True), (120, 330, 190, 80, True),
               (500, 260, 150, 70, False), (60, 60, 140, 60, False)])
    road = [(76, 420), (110, 350), (150, 292), (196, 236), (238, 176), (268, 118), (300, 40)]
    p.band(road, 40, (196, 178, 146), P.INK, 2.5)
    p.band([(150, 292), (60, 250), (0, 230)], 34, (196, 178, 146), P.INK, 2.5)
    for cx, cy in ((69, 169), (227, 84)):
        p.paste("scene-house", cx, cy + 66, 132)
    p.paste("scene-coop", 470, 150, 96)
    p.paste("scene-tree", 560, 330, 118)
    p.paste("scene-tree", 380, 300, 104)
    p.paste("scene-bush", 300, 250, 32)
    p.paste("scene-bush", 180, 380, 32)
    for cx, cy in ((430, 60), (520, 240), (350, 400), (30, 300), (250, 320)):
        p.tuft(cx, cy, 1.1)
    P.hud_panel(p, PLAQUE_BR)
    p.heart(ENERGY)
    return p


def shopfront(warm):
    """Frames 55 and 60. The game covers nearly all of this with its own panel,
    so the plate is a plain front and the money plaque the frame reads on."""
    ground = (233, 200, 130) if warm else (143, 206, 90)
    p = P.Plate(ground)
    p.rounded((-10, -10, 610, 150), 2, WOOD_D)
    p.rounded((-10, -10, 610, 138), 2, WOOD)
    for i in range(11):
        x = -6 + i * 56
        p.rounded((x, -10, x + 44, 136), 6, (186, 124, 74))
    p.poly([(-10, 138), (610, 138), (610, 430), (-10, 430)], ground, P.INK, 2.5)
    for cx, cy, rx in ((110, 250, 110), (450, 340, 120), (300, 190, 90)):
        p.blob(cx, cy, rx, rx * 0.36,
               (219, 186, 118) if warm else (129, 190, 80))
    p.paste("scene-barrel", 44, 400, 62)
    p.paste("scene-bush", 566, 396, 34)
    P.hud_panel(p, (18, 13, 184, 70))
    return p


def menu():
    """Frame 80. Scenery only — the title and the buttons are drawn over it."""
    p = P.Plate()
    p.rolling([(160, 120, 200, 90, True), (450, 300, 200, 85, True),
               (520, 90, 150, 60, False), (90, 340, 150, 70, False)])
    path = [(0, 250), (90, 268), (190, 300), (300, 330), (420, 366), (540, 404), (600, 420)]
    p.band(path, 40, (196, 178, 146), P.INK, 2.5)
    for cx, cy, w, h in ((150, 150, 190, 104), (350, 100, 190, 104), (520, 190, 190, 104),
                         (320, 230, 190, 104), (100, 60, 190, 104)):
        P.soil_plot(p, cx, cy, w, h)
    p.paste("scene-house", 90, 300, 160)
    p.paste("scene-coop", 470, 88, 86)
    p.paste("scene-tree", 590, 300, 120)
    for cx, cy in ((250, 380), (40, 210), (410, 300), (560, 380)):
        p.tuft(cx, cy, 1.2)
    for x0, y0, n in ((230, 300, 3), (10, 130, 2)):
        for i in range(n):
            p.paste("scene-fence", x0 + i * 32, y0 + i * 10, 46)
    return p


def bar(p, slots, box):
    x, y, w, h = box
    p.rounded((x, y, x + w, y + h), 16, P.INK)
    p.rounded((x + 3, y + 3, x + w - 3, y + h - 3), 14, (74, 140, 200))
    p.rounded((x + 8, y + 7, x + w - 8, y + h * 0.46), 9, (108, 176, 226))
    for art, cx, cy in slots:
        s = 25
        p.rounded((cx - s, cy - s, cx + s, cy + s), 9, P.INK)
        p.rounded((cx - s + 2.5, cy - s + 2.5, cx + s - 2.5, cy + s - 2.5), 7, (250, 248, 240))
        p.paste(art, cx, cy + 17, 34)


for name, plate in (("coop", coop()), ("village", village()),
                    ("shop", shopfront(False)), ("shop_animal", shopfront(True)),
                    ("menu", menu())):
    out = ROOT / f"generated/scene-{name}.png"
    plate.save(out)
    print("wrote", out.name)
