#!/usr/bin/env python3
"""Draw vision's located boxes onto each rendered page (the Phase 3 admin-overlay
preview + the placement-verification input). Reads eval-out/<form>/located.json +
p-NN.png, writes overlay-pNN.png. core=red, common=blue. 150-DPI render → px = pt*150/72."""
import json, os, sys
from PIL import Image, ImageDraw, ImageFont

SCALE = 150 / 72.0
ROOT = os.path.join(os.getcwd(), "eval-out")

def font(sz):
    try:
        return ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", sz)
    except Exception:
        return ImageFont.load_default()

def run(form_key):
    d = os.path.join(ROOT, form_key)
    located = json.load(open(os.path.join(d, "located.json")))
    by_page = {}
    for l in located["located"]:
        by_page.setdefault(l["foundPage"], []).append(l)
    made = []
    for page in range(1, located["pageCount"] + 1):
        png = os.path.join(d, f"p-{page:02d}.png")
        if not os.path.exists(png):
            # poppler may pad differently; try unpadded
            alt = os.path.join(d, f"p-{page}.png")
            png = alt if os.path.exists(alt) else png
        if not os.path.exists(png):
            continue
        img = Image.open(png).convert("RGB")
        dr = ImageDraw.Draw(img)
        f = font(16)
        for l in by_page.get(page, []):
            color = (220, 30, 30) if l["tier"] == "core" else (30, 90, 220)
            x0, y0 = l["xTop"] * SCALE, l["yTop"] * SCALE
            w, h = max(l["width"] * SCALE, 6), max(l["height"] * SCALE, 6)
            x1, y1 = x0 + w, y0 + h
            dr.rectangle([x0, y0, x1, y1], outline=color, width=3)
            tag = l["label"][:22]
            dr.text((x0, max(0, y0 - 16)), tag, fill=color, font=f)
        out = os.path.join(d, f"overlay-p{page:02d}.png")
        img.save(out)
        made.append((page, len(by_page.get(page, []))))
    print(f"{form_key}: wrote {len(made)} overlays — " + ", ".join(f"p{p}:{n}" for p, n in made))

if __name__ == "__main__":
    for k in (sys.argv[1:] or ["baldwin_br", "valleymls_financed"]):
        run(k)
