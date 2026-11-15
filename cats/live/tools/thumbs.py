#!/usr/bin/env python3
"""Scene thumbnails for the settings sheet: cats/<style>/<pack>/assets/thumb.jpg (320x180, from the pack's source image).

    python cats/live/tools/thumbs.py            (all packs that have a rig.json)
"""
import os, json, glob
import cv2

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', '..'))
for rp in sorted(glob.glob(os.path.join(ROOT, 'cats', '*', '*', 'rig.json'))):
    src = json.load(open(rp, encoding='utf-8'))['src']
    img = cv2.imread(os.path.join(ROOT, src))
    h, w = img.shape[:2]
    tw = min(w, round(h * 16 / 9)); th = round(tw * 9 / 16)
    x0, y0 = (w - tw) // 2, (h - th) // 2
    t = cv2.resize(img[y0:y0 + th, x0:x0 + tw], (320, 180), interpolation=cv2.INTER_AREA)
    out = os.path.join(os.path.dirname(rp), 'assets', 'thumb.jpg')
    cv2.imwrite(out, t, [cv2.IMWRITE_JPEG_QUALITY, 82])
    print(os.path.relpath(out, ROOT), os.path.getsize(out))
