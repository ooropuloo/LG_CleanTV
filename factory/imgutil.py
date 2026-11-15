"""Image helpers: normalise to the pack size, grid overlay for the vision model, simple composition stats."""
import cv2
import numpy as np

W, H = 1672, 941            # pack size used by every existing scene (16:9)


def normalise(src, dst):
    """Centre-crop to 16:9 and resize to W x H (Lanczos up, area down, light unsharp when upscaling). -> (w0, h0)."""
    im = cv2.imread(src, cv2.IMREAD_COLOR)
    if im is None:
        raise ValueError('unreadable image')
    h, w = im.shape[:2]
    if w < 900 or h < 500:
        raise ValueError(f'image too small {w}x{h}')
    tw = min(w, int(round(h * 16 / 9)))
    th = min(h, int(round(tw * 9 / 16)))
    x0, y0 = (w - tw) // 2, (h - th) // 2
    im = im[y0:y0 + th, x0:x0 + tw]
    up = W > tw
    im = cv2.resize(im, (W, H), interpolation=cv2.INTER_LANCZOS4 if up else cv2.INTER_AREA)
    if up:
        bl = cv2.GaussianBlur(im, (0, 0), 1.2)
        im = cv2.addWeighted(im, 1.35, bl, -0.35, 0)
    cv2.imwrite(dst, im, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    return w, h


def grid(src, dst, width=1280):
    """Downscaled copy with a faint 0..1000 grid (lines every 50, labels every 100)."""
    im = cv2.imread(src)
    h, w = im.shape[:2]
    k = width / w
    im = cv2.resize(im, (width, int(round(h * k))), interpolation=cv2.INTER_AREA)
    h, w = im.shape[:2]
    ov = im.copy()
    for v in range(0, 1001, 50):
        x = int(round(v / 1000 * (w - 1))); y = int(round(v / 1000 * (h - 1)))
        c = (255, 255, 255) if v % 100 == 0 else (190, 190, 190)
        cv2.line(ov, (x, 0), (x, h - 1), c, 1)
        cv2.line(ov, (0, y), (w - 1, y), c, 1)
    im = cv2.addWeighted(ov, 0.35, im, 0.65, 0)
    for v in range(100, 1000, 100):
        x = int(round(v / 1000 * (w - 1))); y = int(round(v / 1000 * (h - 1)))
        for txt, org in ((str(v), (x + 2, 14)), (str(v), (2, y - 3))):
            cv2.putText(im, txt, org, cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 0, 0), 3, cv2.LINE_AA)
            cv2.putText(im, txt, org, cv2.FONT_HERSHEY_SIMPLEX, 0.42, (0, 255, 255), 1, cv2.LINE_AA)
    cv2.imwrite(dst, im, [cv2.IMWRITE_JPEG_QUALITY, 88])


def small(src, dst, width=1280, q=88):
    im = cv2.imread(src)
    h, w = im.shape[:2]
    im = cv2.resize(im, (width, int(round(h * width / w))), interpolation=cv2.INTER_AREA)
    cv2.imwrite(dst, im, [cv2.IMWRITE_JPEG_QUALITY, q])


def ui_zones(img):
    """Composition stats for the UI areas (0..1): mean luminance and detail of the clock (top-left) and right panel areas."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h, w = g.shape
    lap = np.abs(cv2.Laplacian(cv2.GaussianBlur(g, (0, 0), 1.5), cv2.CV_32F))
    def st(x0, y0, x1, y1):
        sl = (slice(int(y0 * h), int(y1 * h)), slice(int(x0 * w), int(x1 * w)))
        return {'lum': round(float(g[sl].mean()) / 255, 3), 'detail': round(float(lap[sl].mean()), 2)}
    return {'clock': st(0, 0, 0.30, 0.33), 'panel': st(0.80, 0.18, 1.0, 0.56), 'whole': st(0, 0, 1, 1)}
