#!/usr/bin/env python3
"""Build the FAEZ app icon from Stooge's synth artwork.

Stooge supplied icon-source.png (his own illustration -- don't substitute
another design). This script centre-crops it to a true square, then emits a
multi-resolution .ico plus a 512px PNG for a DAW artwork slot.

Why the crop + sharpen dance: the source already fills its frame, with only
a 1-2px transparent margin, so there is nothing meaningful to trim -- but its
content is 509x504 inside a 512x512 canvas, i.e. not quite square. Windows
icons must be square or the shell stretches them, so we take the largest
centred square first.

The detail (fader caps, key groups, waveform screen) is fine enough that
plain LANCZOS downsampling turns the 16px and 24px frames to mush, so small
sizes get an unsharp mask afterwards. Verified the way that actually
matters: extract the icon back out of the built .exe with
System.Drawing.Icon.ExtractAssociatedIcon and look at the real 32x32.

Usage:  python make_icon.py
"""
import os
from PIL import Image, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "icon-source.png")
ICO = os.path.join(HERE, "FAEZ.ico")
PNG512 = os.path.join(HERE, "FAEZ-512.png")

SIZES = [16, 24, 32, 48, 64, 128, 256]
# Below this size the source's fine detail stops surviving; unsharp mask it.
SHARPEN_BELOW = 48


def square_crop(im):
    """Trim dead transparent margin, then centre-crop to a true square.

    Windows icons must be square or the shell stretches them. The source's
    alpha bbox is 509x504 inside a 512x512 canvas, so we trim first and then
    take the largest centred square -- that way the synth actually fills the
    icon tile instead of floating in a few px of dead space.
    """
    bbox = im.split()[3].getbbox()
    if bbox:
        im = im.crop(bbox)
    w, h = im.size
    if w == h:
        return im
    s = min(w, h)
    left, top = (w - s) // 2, (h - s) // 2
    return im.crop((left, top, left + s, top + s))


def build():
    im = square_crop(Image.open(SRC).convert("RGBA"))

    frames = []
    for s in SIZES:
        f = im.resize((s, s), Image.LANCZOS)
        if s < SHARPEN_BELOW:
            # radius scales with size; amount kept low to avoid halos
            f = f.filter(ImageFilter.UnsharpMask(
                radius=max(0.5, s / 32.0), percent=90, threshold=2))
        frames.append(f)

    frames[-1].save(ICO, format="ICO", sizes=[(s, s) for s in SIZES])
    im.resize((512, 512), Image.LANCZOS).save(PNG512)

    print("source      :", im.size)
    print("wrote       :", ICO)
    for s in SIZES:
        print("  %3dx%-3d ok" % (s, s))


if __name__ == "__main__":
    build()