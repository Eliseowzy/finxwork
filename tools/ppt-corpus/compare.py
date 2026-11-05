"""Side-by-side sheet of a deck's slides as each renderer draws them, with pixel differences
from the first one (the reference, normally PowerPoint).

    compare.py DECK OUT.png NAME=DIR [NAME=DIR ...]

Each DIR holds DECK-<n>.png for n = 1, 2, ...; the first NAME=DIR is the reference. Prints one
line per slide: mean absolute RGB difference, and the share of pixels whose grey difference
exceeds 40.
"""
import os
import sys

from PIL import Image, ImageChops, ImageDraw, ImageFont

SIZE = (1080, 607)
SCALE = 0.5
THRESHOLD = 40


def load(path):
    if not os.path.exists(path):
        return None
    image = Image.open(path).convert("RGB")
    return image if image.size == SIZE else image.resize(SIZE, Image.LANCZOS)


def difference(reference, image):
    diff = ImageChops.difference(reference, image)
    mean = sum(sum(p) for p in diff.getdata()) / (3 * SIZE[0] * SIZE[1])
    grey = diff.convert("L").getdata()
    over = sum(1 for v in grey if v > THRESHOLD) / len(grey)
    return mean, over


def main(deck, out, columns):
    columns = [c.split("=", 1) for c in columns]
    slides = 1
    while any(os.path.exists(f"{d}/{deck}-{slides + 1}.png") for _, d in columns):
        slides += 1
    try:
        font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
    except OSError:
        font = ImageFont.load_default()
    cw, ch = int(SIZE[0] * SCALE), int(SIZE[1] * SCALE)
    sheet = Image.new("RGB", (cw * len(columns) + 10 * (len(columns) + 1), (ch + 40) * slides + 40), "white")
    draw = ImageDraw.Draw(sheet)
    print(f"deck={deck} reference={columns[0][0]}")
    for n in range(1, slides + 1):
        images = [load(f"{d}/{deck}-{n}.png") for _, d in columns]
        row = []
        for i, (name, _) in enumerate(columns):
            x, y = 10 + i * (cw + 10), 40 + (n - 1) * (ch + 40)
            label = name
            if images[i] is not None:
                sheet.paste(images[i].resize((cw, ch), Image.LANCZOS), (x, y))
                if i > 0 and images[0] is not None:
                    mean, over = difference(images[0], images[i])
                    label += f"  mean={mean:.1f}  >{THRESHOLD}={over * 100:.1f}%"
                    row.append(f"{name}: mean={mean:.2f} >{THRESHOLD}={over * 100:.2f}%")
            draw.rectangle([x - 1, y - 1, x + cw, y + ch], outline="#999")
            draw.text((x, y - 30), f"p{n} {label}", fill="black", font=font)
        print(f"p{n}: " + " | ".join(row))
    sheet.save(out)


if __name__ == "__main__":
    if len(sys.argv) < 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3:])
