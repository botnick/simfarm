"""Paint a scene plate: ground drawn here, objects pasted on top.

The generator draws objects on white beautifully and will not draw ground —
ask it for a grass tile and it returns a picture of a tile, edged and shadowed.
So the ground is drawn in code, flat and full-bleed, and the drawn pieces go
on top of it. Positions come from the frame the plate replaces, so nothing
downstream moves.
"""
import math, sys
from pathlib import Path
from PIL import Image, ImageDraw

W, H = 600, 420
SS = 4                      # supersample, then shrink for clean edges
ROOT = Path(__file__).resolve().parent.parent
GOODS = ROOT / "game/public/assets/goods"

INK    = (74, 50, 34)       # #4a3222 — every outline in the house style
GRASS  = (143, 206, 90)     # #8fce5a
GRASS_L= (159, 221, 107)    # #9fdd6b
GRASS_D= (111, 181, 74)     # #6fb54a
EARTH  = (165, 104, 60)     # #a5683c
EARTH_D= (138, 84, 48)      # #8a5430
SAND   = (233, 200, 130)    # #e9c882
CREAM  = (247, 231, 197)    # #f7e7c5
STONE  = (198, 196, 186)
STONE_L= (222, 220, 210)
SKY    = (109, 190, 233)
RED    = (226, 74, 74)


def ink(px):
    """Outline weight in supersampled units — one value everywhere, per the style rules."""
    return max(1, round(px * SS))


class Plate:
    def __init__(self, ground=GRASS):
        self.im = Image.new("RGB", (W * SS, H * SS), ground)
        self.d = ImageDraw.Draw(self.im)

    def s(self, *v):
        return [x * SS for x in v]

    def blob(self, cx, cy, rx, ry, fill, outline=None, wid=3):
        x0, y0, x1, y1 = self.s(cx - rx, cy - ry, cx + rx, cy + ry)
        self.d.ellipse([x0, y0, x1, y1], fill=fill,
                       outline=outline, width=ink(wid) if outline else 0)

    def poly(self, pts, fill, outline=None, wid=3):
        p = [(x * SS, y * SS) for x, y in pts]
        self.d.polygon(p, fill=fill, outline=outline, width=ink(wid) if outline else 0)

    def band(self, pts, width, fill, outline=None, wid=3):
        """A thick stroked polyline — used for paths and roads."""
        p = [(x * SS, y * SS) for x, y in pts]
        if outline:
            self.d.line(p, fill=outline, width=ink(width + wid * 2), joint="curve")
            for x, y in p:
                r = ink(width + wid * 2) / 2
                self.d.ellipse([x - r, y - r, x + r, y + r], fill=outline)
        self.d.line(p, fill=fill, width=ink(width), joint="curve")
        for x, y in p:
            r = ink(width) / 2
            self.d.ellipse([x - r, y - r, x + r, y + r], fill=fill)

    def rounded(self, box, r, fill, outline=None, wid=3):
        x0, y0, x1, y1 = self.s(*box)
        self.d.rounded_rectangle([x0, y0, x1, y1], radius=r * SS, fill=fill,
                                 outline=outline, width=ink(wid) if outline else 0)

    def rolling(self, seed_spots):
        """Soft flat patches so the ground reads as gently rolling, not a green wall."""
        for cx, cy, rx, ry, light in seed_spots:
            self.blob(cx, cy, rx, ry, GRASS_L if light else GRASS_D)

    def tuft(self, cx, cy, scale=1.0):
        """Three blades — the cheapest thing that stops ground looking empty."""
        for dx, hgt in ((-6, 11), (0, 16), (6, 11)):
            self.poly([(cx + dx * scale - 3.2 * scale, cy),
                       (cx + dx * scale + 3.2 * scale, cy),
                       (cx + dx * scale + 1.0 * scale, cy - hgt * scale)],
                      GRASS_D, INK, 1.6)

    def heart(self, box, rim=5, fill=None, well=(58, 40, 28)):
        """The heart badge the energy meter is drawn inside.

        The meter fills the exact `energy-fill` box with the same parametric
        heart the HUD uses, clipped at the energy level — so this badge is that
        heart plus a rim, not a heart of its own. Draw it any other shape and
        the meter spills out of the badge as a coloured wedge.
        """
        fill = fill or RED
        x, y, w, h = box
        cx, cy = x + w / 2, y + h / 2

        def curve(grow):
            pts = []
            for i in range(73):
                th = (i / 72) * math.pi * 2
                hx = 16 * math.sin(th) ** 3
                hy = 13 * math.cos(th) - 5 * math.cos(2 * th) - 2 * math.cos(3 * th) - math.cos(4 * th)
                pts.append((cx + (hx / 17) * (w / 2 + grow),
                            cy - (hy / 17) * (h / 2 + grow)))
            return pts

        self.poly(curve(rim + 3), INK)
        self.poly(curve(rim), fill)
        self.poly(curve(0), well)
        # gloss on the rim, not in the well — inside, the meter paints over it
        self.blob(cx - w * 0.30, cy - h * 0.30, w * 0.085, h * 0.055, (255, 168, 168))

    def paste(self, name, cx, cy, height, flip=False):
        """Drop a drawn piece, scaled to a height and centred on a ground point."""
        p = GOODS / f"{name}.png"
        if not p.exists():
            print(f"    missing piece: {name}", file=sys.stderr)
            return
        im = Image.open(p).convert("RGBA")
        k = (height * SS) / im.height
        im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.LANCZOS)
        if flip:
            im = im.transpose(Image.FLIP_LEFT_RIGHT)
        self.im.paste(im, (round(cx * SS - im.width / 2), round(cy * SS - im.height)), im)

    def save(self, path, scale=2):
        # Plates are drawn at RENDER_SCALE so the art is crisp at the size the
        # game blits it; the SVG plates it replaces load at the same multiple.
        out = self.im.resize((W * scale, H * scale), Image.LANCZOS)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        out.save(path)
        return out


def soil_plot(p, cx, cy, w, h, rows=3):
    """A tilled patch: a flat diamond of earth with mounded rows across it.

    Flat and low — the plate is seen from above at a slight angle, so a plot
    that bulges reads as a loaf of bread sitting on the grass.
    """
    hw, hh = w / 2, h / 2
    p.poly([(cx, cy - hh), (cx + hw, cy), (cx, cy + hh), (cx - hw, cy)],
           EARTH_D, INK, 2.5)
    # a lighter face inset from the rim, so the plot has a lip rather than
    # reading as one flat brown lozenge
    k = 0.80
    p.poly([(cx, cy - hh * k), (cx + hw * k, cy), (cx, cy + hh * k), (cx - hw * k, cy)],
           EARTH)
    for i in range(rows):
        t = (i + 1) / (rows + 1)
        yy = cy - hh + h * t
        rw = hw * (1 - abs(t - 0.5) * 2) * 0.86
        p.blob(cx, yy, rw, h * 0.075, EARTH_D, INK, 1.4)
        p.blob(cx, yy - h * 0.022, rw * 0.82, h * 0.028, (190, 128, 78))


def hud_panel(p, box, r=10):
    """The frame's own readout panel. It is painted into the plate, not a layer,
    so a replacement plate has to carry it or the numbers lose their ground."""
    x, y, w, h = box
    p.rounded((x, y, x + w, y + h), r + 3, INK)
    p.rounded((x + 3, y + 3, x + w - 3, y + h - 3), r, SKY)
    p.rounded((x + 8, y + 7, x + w - 8, y + h * 0.42), r * 0.6, (150, 214, 245))
