# The home-screen icons (src/icons/*.png): the "舌" glyph (tongue) in paper colour on the accent
# red. Checked in; rerun only to change the look:  python3 scripts/make-icons.py
# Needs Pillow and a CJK font (Noto CJK); pass a font path as the first argument to override.
import os
import sys
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "src", "icons")
FONTS = sys.argv[1:] + [
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/opentype/noto/NotoSerifCJK-Regular.ttc",
]
font_path = next(f for f in FONTS if os.path.exists(f))
os.makedirs(OUT, exist_ok=True)
for size, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png")]:
    img = Image.new("RGB", (size, size), "#b8352a")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(font_path, int(size * 0.62), index=2)  # SC face in the .ttc
    d.text((size / 2, size / 2), "舌", font=font, fill="#fffaf0", anchor="mm")
    img.save(os.path.join(OUT, name), optimize=True)
    print(name, size, font_path)
