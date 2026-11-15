#!/usr/bin/env python3
"""Prove a face moves rigidly: align each face close-up to the first with a Euclidean (rotation + shift) ECC fit
and report the residual. Rigid motion -> residual at resampling-noise level; any warp inside the face -> large.

    python cats/live/tools/rigid_check.py <out sheet.png> <closeup t0.png> <closeup t1.png> ...

The central 60 % of the frame is used (the face), eyes included only as they are (the iris moves by design, so the
number is reported with and without the brightest-change pixels).
"""
import sys
import numpy as np
import cv2

args = sys.argv[1:]
roi = (0.2, 0.2, 0.8, 0.8)
if args and args[0] == '--roi':                 # fractions x0,y0,x1,y1 of the close-up (e.g. nose + mouth, eyes left out)
    roi = tuple(float(v) for v in args[1].split(',')); args = args[2:]
out, files = args[0], args[1:]
ims = [cv2.imread(f) for f in files]
g = [cv2.GaussianBlur(cv2.cvtColor(i, cv2.COLOR_BGR2GRAY).astype(np.float32) / 255, (0, 0), 1.0) for i in ims]
H, W = g[0].shape
m = np.zeros((H, W), np.uint8); m[int(H * roi[1]):int(H * roi[3]), int(W * roi[0]):int(W * roi[2])] = 1
rows = []
for k in range(1, len(g)):
    w = np.eye(2, 3, dtype=np.float32)
    try:
        _, w = cv2.findTransformECC(g[0], g[k], w, cv2.MOTION_EUCLIDEAN, (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 200, 1e-6), m, 5)
    except cv2.error:
        pass
    al = cv2.warpAffine(g[k], w, (W, H), flags=cv2.INTER_LINEAR + cv2.WARP_INVERSE_MAP)
    d0 = np.abs(g[k] - g[0])[m > 0] * 255
    d1 = np.abs(al - g[0])[m > 0] * 255
    ang = np.degrees(np.arctan2(w[1, 0], w[0, 0]))
    rows.append((files[k], w[0, 2], w[1, 2], ang, d0.mean(), d1.mean(), np.percentile(d1, 99)))
    print(f'{files[k].split("/")[-1]:24s} shift=({w[0,2]:+.2f},{w[1,2]:+.2f})px(screen) rot={ang:+.3f}deg  '
          f'mean|diff| before={d0.mean():.2f} after-rigid-fit={d1.mean():.2f}  p99 after={np.percentile(d1, 99):.1f} (0-255)')
# sheet: the close-ups in a row (labelled) + an amplified residual of the last one after the rigid fit
th = 360; tw = int(W * th / H)
tiles = []
for f, im in zip(files, ims):
    t = cv2.resize(im, (tw, th), interpolation=cv2.INTER_AREA)
    cv2.putText(t, f.split('_f')[-1].replace('.png', 's'), (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 4)
    cv2.putText(t, f.split('_f')[-1].replace('.png', 's'), (8, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (180, 255, 220), 2)
    tiles.append(t)
n = len(tiles); cols = 3
grid = []
for r in range(0, n, cols):
    rr = tiles[r:r + cols]
    while len(rr) < cols:
        rr.append(np.zeros_like(tiles[0]))
    grid.append(np.hstack(rr))
cv2.imwrite(out, np.vstack(grid))
