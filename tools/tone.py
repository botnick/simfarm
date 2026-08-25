"""Bring drawn art to the house tone.

The style prompt gets the outline, the shapes and the finish right and kept
missing the tone. The first measurement said what looked obvious — averaged over
sixty images of each, their art sits at saturation 0.23 and brightness 0.85 and
what came out here sat at 0.47 and 0.65 — and the obvious reading of that, wash
everything out by half, is wrong. Their corpus is mostly cream, gold and white
subjects; mine is full of green plants and red fruit. Comparing the averages
compares the subject matter, not the style, and pulling a brown cow down to a
cream average simply stops it being brown.

Compared hue family by hue family instead, the answer is nearly the opposite of
the average and much more specific:

    warm brown/orange   theirs 0.60/0.65   mine 0.50/0.71   -> deepen a little
    yellow/gold         theirs 0.49/0.71   mine 0.43/0.75   -> deepen a little
    green               theirs 0.39/0.57   mine 0.53/0.52   -> calm it down
    cool                theirs 0.35/0.70   mine 0.35/0.71   -> already right

So the greens are too vivid and too dark, the warms are a touch too pale, and
the blues were never wrong. Each family is moved to its own target; the outline
is left alone, being meant to be dark.

    tools/tone.py <file.png> [more.png ...]
    tools/tone.py --measure <file.png> [...]
"""
import colorsys
import sys
from pathlib import Path

import numpy as np
from PIL import Image

# Measured off their finished art, by hue family: (saturation, brightness).
HOUSE = {
    "warm": (0.60, 0.65),      # hue < 45
    "gold": (0.49, 0.71),      # 45 - 70
    "green": (0.39, 0.57),     # 70 - 160
    "cool": (0.35, 0.70),      # 160 +
}
INK = 0.22          # below this brightness it is outline, not colour
FAINT = 0.08        # below this saturation it is a neutral, and hue means nothing


def family(hue_degrees):
    if hue_degrees < 45:
        return "warm"
    if hue_degrees < 70:
        return "gold"
    if hue_degrees < 160:
        return "green"
    return "cool"


def _colours(path):
    im = Image.open(path).convert("RGBA")
    a = np.asarray(im).astype(np.float64)
    rgb = a[..., :3] / 255
    mx, mn = rgb.max(axis=2), rgb.min(axis=2)
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-9), 0)
    usable = (a[..., 3] > 40) & (v > INK) & (s > FAINT)
    return im, a, rgb, s, v, usable


def measure(path):
    _, _, rgb, s, v, usable = _colours(path)
    if usable.sum() < 20:
        return None
    return float(s[usable].mean()), float(v[usable].mean())


def retone(path, out=None):
    """Move each hue family to its own house target, one factor per family."""
    im, a, rgb, s, v, usable = _colours(path)
    if usable.sum() < 20:
        return None

    ys, xs = np.where(usable)
    px = rgb[usable]
    hsv = [colorsys.rgb_to_hsv(*c) for c in px]
    fams = [family(h * 360) for h, _, _ in hsv]

    # One factor per family, measured from this picture, so a drawing that is
    # already right is left alone.
    factors = {}
    for name in HOUSE:
        members = [i for i, f in enumerate(fams) if f == name]
        if not members:
            continue
        have_s = float(np.mean([hsv[i][1] for i in members]))
        have_v = float(np.mean([hsv[i][2] for i in members]))
        want_s, want_v = HOUSE[name]
        factors[name] = (want_s / max(have_s, 1e-6), want_v / max(have_v, 1e-6))

    out_px = px.copy()
    for i, (h, sv, vv) in enumerate(hsv):
        ds, dv = factors[fams[i]]
        out_px[i] = colorsys.hsv_to_rgb(h, min(1.0, sv * ds), min(1.0, vv * dv))
    a[..., :3][usable] = out_px * 255
    Image.fromarray(a.clip(0, 255).astype(np.uint8)).save(out or path)
    return measure(out or path)


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__.strip())
        return 1
    if args[0] == "--measure":
        for f in args[1:]:
            got = measure(f)
            print(f"  {Path(f).name:26} " + (f"saturation {got[0]:.2f}  brightness {got[1]:.2f}" if got else "no colour in it"))
        return 0
    for f in args:
        got = retone(f)
        print(f"  {Path(f).name:26} " + (f"-> saturation {got[0]:.2f}  brightness {got[1]:.2f}" if got else "skipped"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
