#!/usr/bin/env python3
"""Crop + enlarge part of an image with a labelled pixel grid, for placing rig landmarks by eye.

    python cats/live/tools/look.py <image> <out.png> x0 y0 x1 y1 [scale=3] [grid=20] [gamma=1]

Grid labels are in the pixel coordinates of <image>. gamma>1 brightens dark pictures.
"""
import sys
import numpy as np
import cv2


def main():
    a = sys.argv[1:]
    if len(a) < 6:
        print(__doc__)
        sys.exit(64)
    src, out = a[0], a[1]
    x0, y0, x1, y1 = [int(float(v)) for v in a[2:6]]
    scale = float(a[6]) if len(a) > 6 else 3.0
    grid = int(a[7]) if len(a) > 7 else 20
    gamma = float(a[8]) if len(a) > 8 else 1.0
    img = cv2.imread(src, cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit('cannot read ' + src)
    if img.ndim == 2:
        img = cv2.cvtColor(img, cv2.COLOR_GRAY2BGR)
    if img.shape[2] == 4:
        a4 = img[:, :, 3:4].astype(np.float32) / 255
        bg = np.zeros_like(img[:, :, :3]); bg[:] = (255, 0, 255)
        img = (img[:, :, :3] * a4 + bg * (1 - a4)).astype(np.uint8)
    h, w = img.shape[:2]
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(w, x1), min(h, y1)
    crop = img[y0:y1, x0:x1]
    if gamma != 1.0:
        crop = (np.power(crop.astype(np.float32) / 255, 1 / gamma) * 255).astype(np.uint8)
    interp = cv2.INTER_NEAREST if scale >= 6 else cv2.INTER_CUBIC
    big = cv2.resize(crop, None, fx=scale, fy=scale, interpolation=interp)
    if grid > 0:
        ov = big.copy()
        gx = (x0 // grid + 1) * grid
        while gx < x1:
            X = int(round((gx - x0) * scale))
            major = gx % (grid * 5) == 0
            cv2.line(ov, (X, 0), (X, big.shape[0] - 1), (0, 255, 255) if major else (0, 200, 0), 1)
            if major or scale * grid >= 60:
                cv2.putText(ov, str(gx), (X + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(ov, str(gx), (X + 2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
            gx += grid
        gy = (y0 // grid + 1) * grid
        while gy < y1:
            Y = int(round((gy - y0) * scale))
            major = gy % (grid * 5) == 0
            cv2.line(ov, (0, Y), (big.shape[1] - 1, Y), (0, 255, 255) if major else (0, 200, 0), 1)
            if major or scale * grid >= 60:
                cv2.putText(ov, str(gy), (2, Y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 3, cv2.LINE_AA)
                cv2.putText(ov, str(gy), (2, Y - 3), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1, cv2.LINE_AA)
            gy += grid
        big = cv2.addWeighted(ov, 0.55, big, 0.45, 0)
    cv2.imwrite(out, big)
    print(out, big.shape[1], 'x', big.shape[0])


if __name__ == '__main__':
    main()
