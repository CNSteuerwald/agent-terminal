# Regenerates the installer art in this folder: python build/make-installer-art.py (needs Pillow).
# Colors come from the dark theme in src/renderer/styles.css.
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent
BG, BG2, TERM, FG, MUTED, ACCENT, BORDER = "#202020", "#2b2b2b", "#0c0c0c", "#e6e6e6", "#9d9d9d", "#4cc2ff", "#3a3a3a"


def font(size, bold=False):
    for name in (["consolab.ttf"] if bold else []) + ["consola.ttf", "cour.ttf"]:
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            pass
    return ImageFont.load_default(size)


def logo(size):
    """Rounded terminal window with a '>_' prompt."""
    s = 4  # draw big, then downscale for smooth edges
    n = size * s
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    r = n * 0.2
    d.rounded_rectangle([0, 0, n - 1, n - 1], r, fill=TERM, outline=BORDER, width=max(s, n // 48))
    d.rounded_rectangle([0, 0, n - 1, n * 0.2], r, fill=BG2)
    d.rectangle([0, n * 0.12, n - 1, n * 0.2], fill=BG2)
    for i, c in enumerate(("#ff6b6b", "#ffc857", "#5ad17a")):
        cx, cy, cr = n * (0.16 + i * 0.11), n * 0.1, n * 0.035
        d.ellipse([cx - cr, cy - cr, cx + cr, cy + cr], fill=c)
    w = max(s, int(n * 0.07))
    d.line([(n * 0.22, n * 0.42), (n * 0.42, n * 0.58), (n * 0.22, n * 0.74)], fill=ACCENT, width=w, joint="curve")
    d.line([(n * 0.5, n * 0.76), (n * 0.78, n * 0.76)], fill=FG, width=w)
    return img.resize((size, size), Image.LANCZOS)


def paste(base, img, xy):
    base.paste(img, xy, img)


# App + installer icon
logo(256).save(OUT / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# Welcome/finish sidebar, 164x314
side = Image.new("RGB", (164, 314), BG)
d = ImageDraw.Draw(side)
for y in range(314):  # top-to-bottom fade from terminal black to the window background
    t = y / 313
    c = tuple(int(int(TERM[i:i + 2], 16) * (1 - t) + int(BG[i:i + 2], 16) * t) for i in (1, 3, 5))
    d.line([(0, y), (163, y)], fill=c)
paste(side, logo(72), (46, 40))
d.text((82, 140), "Agent", font=font(22, True), fill=FG, anchor="mm")
d.text((82, 164), "Terminal", font=font(22, True), fill=FG, anchor="mm")
d.line([(62, 184), (102, 184)], fill=ACCENT, width=2)
lines = [("> ", "claude"), ("> ", "copilot"), ("> ", "codex"), ("> ", "gemini"), ("$ ", "_")]
for i, (p, cmd) in enumerate(lines):
    y = 214 + i * 16
    d.text((28, y), p, font=font(12), fill=ACCENT)
    d.text((44, y), cmd, font=font(12), fill=MUTED)
d.rectangle([163, 0, 163, 313], fill=BORDER)
side.save(OUT / "installerSidebar.bmp")
side.save(OUT / "uninstallerSidebar.bmp")

# Page header image (right side of the header band), 150x57
head = Image.new("RGB", (150, 57), BG)
d = ImageDraw.Draw(head)
paste(head, logo(36), (106, 10))
d.text((98, 22), "Agent", font=font(13, True), fill=FG, anchor="rm")
d.text((98, 36), "Terminal", font=font(13, True), fill=ACCENT, anchor="rm")
head.save(OUT / "installerHeader.bmp")
