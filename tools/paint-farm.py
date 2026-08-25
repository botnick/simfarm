"""The farm plate — the frame the player spends the game on.

Positions are taken from the frame this replaces: the house top-left, the coop
top-middle, the four plots where their hotspots are, the path running between
them, and the readout panel bottom-left. Nothing here moves, so no coordinate
in the game or in the tests has to change.
"""
import importlib.util as u
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
spec = u.spec_from_file_location("painter", ROOT / "tools/paint-scene.py")
P = u.module_from_spec(spec); spec.loader.exec_module(P)

p = P.Plate()

# gently rolling ground, flat patches only — no gradients in this style
p.rolling([
    (110, 200, 150, 70, True), (430, 120, 190, 90, True), (300, 380, 220, 80, True),
    (520, 300, 130, 70, False), (60, 350, 120, 60, False), (250, 60, 140, 55, False),
])

# the cobble path: house door, down past the plots, out to the village corner
PATH = [(170, 150), (215, 190), (270, 232), (330, 268), (395, 300), (470, 335), (545, 380), (600, 412)]
p.band(PATH, 42, (196, 178, 146), P.INK, 2.5)
# Cobbles are laid across the band, not in screen space — offsetting by a fixed
# dx/dy leaves one edge of a diagonal path bare.
import math

STEP = 17.0
carry = 0.0
row = 0
for i, (x, y) in enumerate(PATH[:-1]):
    nx, ny = PATH[i + 1]
    seg = math.hypot(nx - x, ny - y)
    ux, uy = (nx - x) / seg, (ny - y) / seg      # along the path
    px, py = -uy, ux                             # across it
    d = carry
    while d < seg:
        cx, cy = x + ux * d, y + uy * d
        stagger = 0.5 if row % 2 else 0.0
        for k in (-1.5, -0.5, 0.5, 1.5):
            off = (k + stagger) * 11.5
            if abs(off) > 20:
                continue
            sx, sy = cx + px * off, cy + py * off
            rr = 7.4 - abs(off) * 0.055
            tone = (P.STONE, P.STONE_L, (178, 176, 167))[(row + int(k * 2)) % 3]
            p.blob(sx, sy, rr, rr * 0.76, tone, P.INK, 1.6)
        d += STEP
        row += 1
    carry = d - seg

# the four plots, on their hotspots
P.soil_plot(p, 470, 126, 200, 118)      # field 3, upper right
P.soil_plot(p, 548, 244, 158, 96)       # field 4, right
P.soil_plot(p, 185, 258, 190, 108)      # field 1, left
P.soil_plot(p, 300, 380, 190, 104)      # field 2, bottom middle

# tufts so no stretch of ground sits empty
for cx, cy in ((45, 120), (250, 130), (600 - 30, 60), (95, 300), (410, 210),
               (285, 190), (500, 400), (150, 400), (585, 180), (20, 250)):
    p.tuft(cx, cy, 1.1)

# fence runs along the path, as the frame has them
for x0, y0, n, dx, dy in ((24, 214, 4, 31, 9), (206, 60, 2, 31, 22),
                          (430, 40, 3, 32, 8), (392, 268, 2, 32, 18)):
    for i in range(n):
        p.paste("scene-fence", x0 + i * dx, y0 + i * dy, 48)

# buildings
p.paste("scene-house", 104, 170, 168)
p.paste("scene-coop", 316, 88, 88)
p.paste("scene-tree", 22, 96, 108)
p.paste("scene-bush", 148, 222, 30)
p.paste("scene-bush", 556, 300, 30)
p.paste("scene-barrel", 268, 168, 34)

# the readout panel and the heart, both painted into the frame this replaces
P.hud_panel(p, (19, 331, 227, 72))
p.heart((516.1, 13.25, 63.25, 43.65))   # the energy-fill box this frame declares

out = ROOT / "generated/scene-farm.png"
p.save(out)
print("wrote", out)
