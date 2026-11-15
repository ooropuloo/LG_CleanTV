#!/usr/bin/env python3
"""Offline prep for a "living image" cat pack.

    python cats/live/tools/prep.py <style> <coat>        e.g.  prep.py pixar black

Reads   cats/<style>-live/<coat>/rig.json   (hand-placed landmarks in source pixels + tunables)
and the source image it names, writes
        cats/<style>-live/<coat>/assets/{plate.jpg, cat.png, eyes.png, mesh.bin, pack.json}
plus debug images  dev/shots/live/_dbg/<style>_<coat>_*.png  (matte over magenta, rig overlay, plate).
Deterministic: same image + rig -> same assets.
"""
import sys, os, json, math
import numpy as np
import cv2
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))
DBG = os.environ.get('LIVE_DBG') or os.path.join(ROOT, 'dev', 'shots', 'live', '_dbg')   # factory: per-run debug folder
F32 = np.float32


def sstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def blur(m, s):
    return cv2.GaussianBlur(m.astype(F32), (0, 0), s) if s > 0 else m.astype(F32)


def disk(r):
    r = int(round(r))
    return cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))


def dil(m, r):
    return cv2.dilate(m.astype(np.uint8), disk(r)) > 0 if r > 0 else m.astype(bool)


def ero(m, r):
    return cv2.erode(m.astype(np.uint8), disk(r)) > 0 if r > 0 else m.astype(bool)


def chaikin(pts, n=2):
    pts = np.asarray(pts, float)
    for _ in range(n):
        q = [pts[0]]
        for a, b in zip(pts[:-1], pts[1:]):
            q += [0.75 * a + 0.25 * b, 0.25 * a + 0.75 * b]
        q.append(pts[-1])
        pts = np.array(q)
    return pts


def resample(pts, n):
    seg = np.linalg.norm(np.diff(pts, axis=0), axis=1)
    L = np.concatenate([[0], np.cumsum(seg)])
    u = np.linspace(0, L[-1], n)
    return np.stack([np.interp(u, L, pts[:, 0]), np.interp(u, L, pts[:, 1])], 1), L[-1]


def pushpull(img, valid):
    """Smooth fill of img where valid is False (multi-scale normalized averaging)."""
    if img.shape[2] == 1:
        return pushpull(np.repeat(img, 3, 2), valid)[..., :1]
    a = img.astype(F32) * valid[..., None]
    w = valid.astype(F32)
    pyr = []
    while min(a.shape[:2]) > 4:
        pyr.append((a, w))
        h, wd = a.shape[:2]
        a = cv2.resize(a, ((wd + 1) // 2, (h + 1) // 2), interpolation=cv2.INTER_AREA)
        w = cv2.resize(w, ((wd + 1) // 2, (h + 1) // 2), interpolation=cv2.INTER_AREA)
    c = a / np.maximum(w, 1e-6)[..., None]
    for a, w in reversed(pyr):
        up = cv2.resize(c, (a.shape[1], a.shape[0]), interpolation=cv2.INTER_LINEAR)
        cl = a / np.maximum(w, 1e-6)[..., None]
        k = np.clip(w * 2.0, 0, 1)[..., None]
        c = cl * k + up * (1 - k)
    return np.where(valid[..., None], img, c)


def guided(I, p, r, eps):
    box = lambda x: cv2.boxFilter(x, -1, (2 * r + 1, 2 * r + 1))
    mI, mp = box(I), box(p)
    cov = box(I * p) - mI * mp
    var = box(I * I) - mI * mI
    a = cov / (var + eps)
    b = mp - a * mI
    return box(a) * I + box(b)


def polyfit_bg(img, mask, deg):
    H, W = mask.shape
    ys, xs = np.nonzero(mask)
    rng = np.random.RandomState(7)
    if len(xs) > 60000:
        k = rng.choice(len(xs), 60000, replace=False)
        ys, xs = ys[k], xs[k]
    terms = lambda X, Y: [X ** i * Y ** j for i in range(deg + 1) for j in range(deg + 1 - i)]
    A = np.stack(terms(xs / W * 2 - 1, ys / H * 2 - 1), 1)
    gy, gx = np.mgrid[0:H, 0:W]
    T = np.stack(terms(gx / W * 2 - 1, gy / H * 2 - 1), -1).astype(F32)
    out = np.zeros((H, W, 3), F32)
    for ch in range(3):
        coef = np.linalg.lstsq(A, img[ys, xs, ch], rcond=None)[0]
        out[..., ch] = T @ coef.astype(F32)
    res = np.abs(out[ys, xs] - img[ys, xs]).mean()
    return out, res


def contact_curve(rig, img, W, H):
    c = rig['contact']
    if c.get('points'):
        p = np.array(c['points'], float)
        return np.interp(np.arange(W), p[:, 0], p[:, 1]).astype(F32), None
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    gray = img.mean(2)
    bl = (gray > c['gray']) & (b > r + c.get('blue', 0))
    bl[:c['ymin']] = False
    bl = cv2.morphologyEx(bl.astype(np.uint8), cv2.MORPH_OPEN, disk(c.get('open', 3))) > 0
    run = 21
    cs = np.cumsum(np.vstack([np.zeros((1, W)), bl.astype(F32)]), 0)
    fwd = np.zeros((H, W), F32)
    fwd[:H - run] = (cs[run:H] - cs[:H - run]) / run
    good = fwd > 0.75
    top = np.where(good.any(0), good.argmax(0), H - 1).astype(float)
    base = ndi.median_filter(top, c.get('basewin', 201), mode='nearest')
    top = np.maximum(top, base - c.get('maxUp', 16))          # reject upward spikes (light fur passing the blanket test)
    env = ndi.minimum_filter1d(ndi.median_filter(top, c.get('medwin', 41)), c.get('minwin', 21))
    for x0, x1 in c.get('bridge', []):
        env[x0:x1] = np.interp(np.arange(x0, x1), [x0 - 1, x1], [env[x0 - 1], env[min(x1, W - 1)]])
    env = ndi.gaussian_filter1d(env, c.get('smooth', 6)) + c.get('offset', 0)
    return env.astype(F32), top


def poly_mask(W, H, pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillConvexPoly(m, cv2.convexHull(np.round(np.array(pts)).astype(np.int32)), 1)
    return m > 0


def main():
    style, coat = sys.argv[1], sys.argv[2]
    pack = os.path.join(ROOT, 'cats', style + '-live', coat)
    out = os.path.join(pack, 'assets')
    os.makedirs(out, exist_ok=True)
    os.makedirs(DBG, exist_ok=True)
    rig = json.load(open(os.path.join(pack, 'rig.json'), encoding='utf-8'))
    tag = f'{style}_{coat}'
    bgr = cv2.imread(os.path.join(ROOT, rig['src']), cv2.IMREAD_COLOR)
    img = bgr[..., ::-1].astype(F32)
    H, W = img.shape[:2]
    gray = img.mean(2)
    gy, gx = np.mgrid[0:H, 0:W]
    M = rig['matte']

    # ---------- contact line ----------
    yc, top = contact_curve(rig, img, W, H)
    above = gy < yc[None, :]
    band = rig.get('anchorBand', 70)
    anchor = sstep(0, band, yc[None, :] - gy).astype(F32)

    # ---------- rough regions from landmarks ----------
    eyes = rig['eyes']
    hp = []
    for e in eyes:
        cx, cy = e['c']; rx, ry = e['r']
        hp += [(cx - rx * 1.5, cy), (cx + rx * 1.5, cy), (cx, cy - ry * 1.5)]
    for e in rig['ears']:
        hp += [e['tip'], e['base']]
    x0p, y0p, x1p, y1p = rig['paw']
    hp += [(x0p, y0p), (x1p, y0p), (x0p, y1p), (x1p, y1p)]
    hp += [(e['c'][0], float(yc[int(e['c'][0])])) for e in eyes]
    hp += rig.get('hullExtra', [])
    head = poly_mask(W, H, hp)
    tailp = chaikin(rig['tail'], 3)
    trad = rig['tailRadius']
    tail_rough = np.zeros((H, W), np.uint8)
    dense, Lt = resample(tailp, 200)
    for i, p in enumerate(dense):
        rr = trad[0] + (trad[1] - trad[0]) * i / 199
        cv2.circle(tail_rough, (int(p[0]), int(p[1])), int(rr), 1, -1)
    tail_rough = tail_rough > 0
    rough = head | tail_rough

    # ---------- matte + background estimate ----------
    if M['kind'] == 'gradient':
        r, g, b = img[..., 0], img[..., 1], img[..., 2]
        samp = ~dil(rough, M.get('sampleGap', 40)) & (gy < yc[None, :] - 8) & (b > r + M.get('bgBlue', 30))
        B, res = polyfit_bg(img, samp, M.get('deg', 4))
        print('bg fit residual', round(float(res), 2))
        D = np.sqrt(((img - B) ** 2).sum(2))
        a = sstep(M['t0'], M['t1'], D)
        a *= dil(rough, M.get('reach', 70))
        core = a > 0.5
        lab, n = ndi.label(core)
        keep = np.zeros(n + 1, bool)
        keep[np.unique(lab[ero(rough, 10) & core])] = True
        keep[0] = False
        core = keep[lab]
        core = ndi.binary_fill_holes(core)
        a = np.maximum(a * blur(dil(core, 8), 3).clip(0, 1), core.astype(F32) * (a > 0.3))
        a = np.maximum(a, ero(core, 3).astype(F32))
        cr = M.get('closeR', 14)
        if cr:
            solid = ndi.binary_fill_holes(cv2.morphologyEx(core.astype(np.uint8), cv2.MORPH_CLOSE, disk(cr)) > 0)
            a = np.maximum(a, blur(ero(solid, M.get('closeErode', 9)), 1.5))
    else:
        img8 = np.ascontiguousarray(bgr)
        gm = np.full((H, W), cv2.GC_BGD, np.uint8)
        gm[dil(rough, M.get('reach', 50))] = cv2.GC_PR_BGD
        gm[rough] = cv2.GC_PR_FGD
        # sure-foreground seeds: face ellipse, ear spines, paw core (NOT the convex hull: it spans background)
        fcx = (eyes[0]['c'][0] + eyes[1]['c'][0]) / 2
        ed = abs(eyes[1]['c'][0] - eyes[0]['c'][0])
        ftop = min(eyes[0]['c'][1], eyes[1]['c'][1]) - ed * M.get('faceUp', 0.75)
        fbot = rig['nose'][1] + ed * 0.25
        fg = ((gx - fcx) / (ed * M.get('faceW', 0.95))) ** 2 + ((gy - (ftop + fbot) / 2) / ((fbot - ftop) / 2)) ** 2 < 1
        sp = np.zeros((H, W), np.uint8)
        for e in rig['ears']:
            b_, t_ = np.array(e['base'], float), np.array(e['tip'], float)
            cv2.line(sp, tuple(np.round(b_).astype(int)), tuple(np.round(b_ + 0.75 * (t_ - b_)).astype(int)), 1, M.get('earSpine', 9))
            # thin line through the tip (+ tuft) so dark tufts are not left behind in the plate
            cv2.line(sp, tuple(np.round(b_ + 0.7 * (t_ - b_)).astype(int)), tuple(np.round(b_ + M.get('tuft', 1.06) * (t_ - b_)).astype(int)), 1, 3)
        fg |= sp > 0
        fg |= poly_mask(W, H, [(x0p + 20, y0p + 25), (x1p - 25, y0p + 25), (x1p - 25, y1p - 30), (x0p + 20, y1p - 30)])
        tc = np.zeros((H, W), np.uint8)
        cv2.polylines(tc, [np.round(dense).astype(np.int32)], False, 1, max(2, int(trad[1] * 0.8)))
        fg |= tc > 0
        for e in eyes:
            fg |= ((gx - e['c'][0]) / e['r'][0]) ** 2 + ((gy - e['c'][1]) / e['r'][1]) ** 2 < 1.5
        for poly in M.get('fgPolys', []):
            fg |= poly_mask(W, H, poly)
        for poly in M.get('bgPolys', []):
            gm[poly_mask(W, H, poly) & ~fg] = cv2.GC_BGD
        gm[fg] = cv2.GC_FGD
        gm[gy > yc[None, :] + 6] = cv2.GC_BGD
        bm, fm = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
        cv2.grabCut(img8, gm, None, bm, fm, M.get('iters', 6), cv2.GC_INIT_WITH_MASK)
        hard = (gm == cv2.GC_FGD) | (gm == cv2.GC_PR_FGD)
        hard = cv2.morphologyEx(hard.astype(np.uint8), cv2.MORPH_OPEN, disk(2)) > 0
        lab, n = ndi.label(hard)
        keep = np.zeros(n + 1, bool)
        keep[np.unique(lab[fg & hard])] = True
        keep[0] = False
        hard = ndi.binary_fill_holes(keep[lab])
        valid = ~dil(hard, M.get('bgGap', 16)) & (gy < yc[None, :] - 3)
        B = pushpull(img, valid)
        B = np.where(valid[..., None], img, cv2.GaussianBlur(B, (0, 0), 3))
        D = np.sqrt(((img - B) ** 2).sum(2))
        ag = guided(gray / 255, hard.astype(F32), M.get('gfR', 4), M.get('gfEps', 2e-3)).clip(0, 1)
        ad = sstep(M['t0'], M['t1'], D) * dil(hard, M.get('fuzz', 6))
        a = np.maximum(ag, ad)
        # feather the edge a little (grabCut edges on dark fur read as cut-out otherwise)
        a = np.where(ero(hard, M.get('edgeKeep', 5)), 1.0, blur(a, M.get('edgeSoft', 1.3))).astype(F32)

    # whiskers: thin bright lines in given boxes -> forced into matte, removed from plate
    th = cv2.morphologyEx(gray.astype(F32), cv2.MORPH_TOPHAT, disk(M.get('whiskTop', 4)))
    wmask = np.zeros((H, W), F32)
    for bx in rig.get('whiskerBoxes', []):
        x0, y0, x1, y1 = bx
        sub = sstep(M.get('wt0', 18), M.get('wt1', 45), th[y0:y1, x0:x1])
        wmask[y0:y1, x0:x1] = np.maximum(wmask[y0:y1, x0:x1], sub)
    wmask *= above
    # not near the eyes or on the paw (rims and fur tufts look like bright lines too)
    for e in eyes:
        wmask *= ((gx - e['c'][0]) / (e['r'][0] * 1.25)) ** 2 + ((gy - e['c'][1]) / (e['r'][1] * 1.25)) ** 2 > 1
    wmask *= ~((gx > x0p - 10) & (gx < x1p + 10) & (gy > y0p - 10))
    # keep long thin line-like components only (whiskers), not fur strands
    lab, n = ndi.label(wmask > 0.3, structure=np.ones((3, 3)))
    if n:
        ok = np.zeros(n + 1, bool)
        for i, sl_ in enumerate(ndi.find_objects(lab)):
            ys_, xs_ = np.nonzero(lab[sl_] == i + 1)
            if len(xs_) < 10:
                continue
            (_, _), (w_, h_), _ = cv2.minAreaRect(np.stack([xs_, ys_], 1).astype(np.float32))
            L_ = max(w_, h_)
            ok[i + 1] = L_ >= M.get('whiskMinLen', 60) and len(xs_) / max(L_, 1) <= M.get('whiskMaxW', 4.0)
        wmask *= blur(dil(ok[lab], 2), 1).clip(0, 1)
    # whiskers live in their own overlay layer (swayed per pixel in the shader): the cat layer gets
    # a whisker-free matte/colour, the plate loses them too.
    wsel = dil(wmask > 0.05, 1)
    a_nw = np.where(wsel, pushpull(a[..., None], ~wsel)[..., 0], a).astype(F32)
    a = np.maximum(a, wmask)
    if M['kind'] != 'gradient':
        # whiskers must not remain in the plate
        valid2 = valid & ~dil(wmask > 0.05, 4)
        B = pushpull(img, valid2)
        B = np.where(valid2[..., None], img, cv2.GaussianBlur(B, (0, 0), 3))
        if M.get('grain', 0) > 0:
            rs = np.random.RandomState(11)
            B = B + (~valid2)[..., None] * rs.normal(0, M['grain'], (H, W, 1)).astype(F32)

    # cut at the contact line (soft 2px)
    s_lo = sstep(-2, 2, gy - yc[None, :]).astype(F32)   # 0 above, 1 below
    a = (a * (1 - s_lo)).clip(0, 1).astype(F32)
    a_nw = (a_nw * (1 - s_lo)).clip(0, 1).astype(F32)
    wmask = (wmask * (1 - s_lo)).astype(F32)

    # ---------- plate ----------
    R = dil(a > 0.01, rig.get('plateGrow', 8))
    # stray fibres around the tail would stay behind as a ghost when it swings: fill wider there
    if rig.get('tailGrow', 0):
        R |= dil((a > 0.01) & dil(tail_rough, 25), rig['tailGrow'])
    R &= gy < yc[None, :] + 3
    m = blur(R, 2).clip(0, 1) * (1 - sstep(-7, -3, gy - yc[None, :]))   # original pixels from just above the contact (cat fades over them)
    if M['kind'] == 'gradient':
        # match the original backdrop exactly at the fill border: add a smooth fill of the fit residual
        okb = ~R & (gy < yc[None, :] - 4) & (np.abs(img - B).sum(2) < 40)
        res = pushpull(np.where(okb[..., None], img - B, 0), okb)
        Bp = B + cv2.GaussianBlur(res, (0, 0), 6)
    else:
        Bp = B
    plate = img * (1 - m[..., None]) + Bp * m[..., None]

    # ---------- foreground colour (decontaminated, bled outward) ----------
    Fc = (img - (1 - a_nw[..., None]) * plate) / np.maximum(a_nw, 1e-3)[..., None]   # vs. the layer actually underneath
    Fc = Fc.clip(0, 255)
    core = a_nw > 0.97
    num = cv2.GaussianBlur(img * core[..., None], (0, 0), 6)
    den = cv2.GaussianBlur(core.astype(F32), (0, 0), 6)[..., None]
    Fs = num / np.maximum(den, 1e-4)
    k = sstep(0.08, 0.35, a_nw)[..., None]
    F = np.where(den > 0.02, Fc * k + Fs * (1 - k), Fc)
    F = np.where(a_nw[..., None] > 0.97, img, F)
    F = pushpull(F, a_nw > 0.03)
    F = np.where(wsel[..., None], pushpull(F, ~wsel & (a_nw > 0.03)), F)     # fur under the whiskers

    # ---------- eyes: highlights out of the warped layer ----------
    hlm = np.zeros((H, W), F32)
    for e in eyes:
        cx, cy = e['c']; rx, ry = e['r']; ang = math.radians(e.get('rot', 0))
        dx, dy = gx - cx, gy - cy
        qx = (dx * math.cos(ang) + dy * math.sin(ang)) / rx
        qy = (-dx * math.sin(ang) + dy * math.cos(ang)) / ry
        inside = qx * qx + qy * qy < 0.92
        x0, y0, x1, y1 = int(cx - rx), int(cy - ry), int(cx + rx) + 1, int(cy + ry) + 1
        L = gray[y0:y1, x0:x1]
        # specular highlights only: compact, roundish, very bright blobs well inside the eye
        # (not the sclera crescent or the iris rim, which are long arcs touching the rim)
        tr = max(3, int(max(rx, ry) * 0.2))
        toph = cv2.morphologyEx(L.astype(F32), cv2.MORPH_TOPHAT, disk(tr))
        satv = img[y0:y1, x0:x1].max(2) - img[y0:y1, x0:x1].min(2)
        cand = (toph > e.get('hlTop', 45)) & (L > e.get('hlMin', 160)) & (satv < e.get('hlSat', 70)) & (qx[y0:y1, x0:x1] ** 2 + qy[y0:y1, x0:x1] ** 2 < e.get('hlR', 0.62) ** 2)
        lab, n = ndi.label(cand)
        keepc = np.zeros(n + 1, bool)
        for i, sl_ in enumerate(ndi.find_objects(lab)):
            hh_, ww_ = sl_[0].stop - sl_[0].start, sl_[1].stop - sl_[1].start
            area = (lab[sl_] == i + 1).sum()
            keepc[i + 1] = max(hh_, ww_) <= 0.5 * max(rx, ry) and max(hh_, ww_) <= 2.2 * max(1, min(hh_, ww_)) and area >= 3
        h = keepc[lab].astype(F32)
        hlm[y0:y1, x0:x1] = np.maximum(hlm[y0:y1, x0:x1], h)
    hlm = blur(dil(hlm > 0.5, 2), 1.2).clip(0, 1)
    inp = pushpull(F, ~dil(hlm > 0.03, 3))
    hk = blur(dil(hlm > 0.03, 3), 1.5)[..., None]
    Fcat = F * (1 - hk) + inp * hk
    # whisker layer: alpha = whisker mask only, colour solved so that at rest
    #   mix(under, Wc, wm) == src   (under = whisker-free cat over the plate)
    under = Fcat * a_nw[..., None] + plate * (1 - a_nw[..., None])
    # smallest alpha that reproduces src exactly with a colour in [0,255], at least the whisker mask
    dlt = img - under
    need = np.where(dlt > 0, dlt / np.maximum(255 - under, 1), -dlt / np.maximum(under, 1)).max(2)
    zone = dil(wmask > 0.05, 2) & (gy < yc[None, :] - 2)
    wA = np.where(zone, np.clip(np.maximum(wmask, need), 0, 1), 0).astype(F32)
    Wc = np.clip(under + dlt / np.maximum(wA, 1e-3)[..., None], 0, 255)
    Wc = pushpull(Wc, wA > 0.02)

    # ---------- weights ----------
    # tail: arc-length coordinate via nearest centreline sample
    K = rig.get('tailJoints', 12)
    joints, _ = resample(tailp, K)
    dn, _ = resample(tailp, 400)
    lbl = np.ones((H, W), np.uint8)
    idx_img = np.full((H, W), -1, np.int32)
    for i, p in enumerate(dn):
        xi, yi = int(round(p[0])), int(round(p[1]))
        if 0 <= xi < W and 0 <= yi < H:
            lbl[yi, xi] = 0
            idx_img[yi, xi] = i
    dist, (iy, ix) = ndi.distance_transform_edt(lbl, return_indices=True)
    tS = (idx_img[iy, ix] / 399.0).astype(F32)
    radS = trad[0] + (trad[1] - trad[0]) * tS
    tailW = 1 - sstep(radS + rig.get('tailIn', 18), radS * 1.4 + rig.get('tailOut', 45), dist)
    tailW *= (1 - blur(dil(head, 10), 12)).clip(0, 1)
    tailW = blur(tailW, 4) * anchor
    # head
    headW = blur(dil(head, 25) & ~tail_rough, rig.get('headSoft', 30)).clip(0, 1)
    headW = np.minimum(1, headW * 1.6) * (1 - tailW) * anchor
    # ears
    earW = []
    for e in rig['ears']:
        tip, base = np.array(e['tip'], float), np.array(e['base'], float)
        ax = tip - base; Le = np.linalg.norm(ax); u = ax / Le; nrm = np.array([-u[1], u[0]])
        px, py = gx - base[0], gy - base[1]
        t = (px * u[0] + py * u[1]) / Le
        lat = np.abs(px * nrm[0] + py * nrm[1]) / (e.get('halfw', 0.5 * Le) * (1 - 0.55 * np.clip(t, 0, 1)) + 20)
        w = sstep(-0.12, 0.45, t) * (1 - sstep(0.85, 1.35, lat))
        earW.append(blur(w, 5) * anchor)
    # paw
    pr = rig.get('pawSoft', 30)
    pawW = sstep(x0p - pr, x0p + 10, gx) * (1 - sstep(x1p - 10, x1p + pr, gx)) * sstep(y0p - pr * 1.5, y0p + 15, gy)
    pawW = blur(pawW, 6) * sstep(0, rig.get('pawBand', 40), yc[None, :] - gy)
    # whiskers
    whW = blur(dil(wmask > 0.1, 5), 4).clip(0, 1)
    whR = []
    for i, root in enumerate(rig['whiskerRoots']):
        d = np.hypot(gx - root[0], gy - root[1])
        side = (gx < root[0] + 15) if i == 0 else (gx > root[0] - 15)
        whR.append(sstep(20, rig.get('whiskRamp', 160), d) * side)
    # broad and smooth (a 6px mesh cannot follow single hairs): everything outside the face core,
    # ramping up with distance from the whisker root; whiskers lying on the face stay put.
    facecore = blur(ero((a > 0.9) & head, rig.get('whiskCoreErode', 6)), rig.get('whiskSoft', 14)).clip(0, 1)
    whiskW = (1 - facecore) * np.maximum(whR[0], whR[1]) * dil(whW > 0.05, 40) * anchor * (1 - pawW)
    whiskW = blur(whiskW, 10) * 0      # whiskers now sway in the fragment shader (overlay layer)
    # breath
    breathW = blur((a_nw > 0.5) & ~tail_rough, 20).clip(0, 1) * anchor
    # depth proxy: inflated head matte + muzzle bump
    hm = (a_nw > 0.5) & head & ~tail_rough & above
    edt = ndi.distance_transform_edt(hm)
    dep = np.sqrt(np.clip(edt / (edt.max() * 0.6), 0, 1))
    nose = rig['nose']
    eyed = abs(eyes[1]['c'][0] - eyes[0]['c'][0])
    dep = dep * 0.7 + 0.5 * np.exp(-((gx - nose[0]) ** 2 + (gy - nose[1]) ** 2) / (2 * (0.55 * eyed) ** 2))
    dep = blur(dep * dil(hm, 6), 8)
    dep = (dep / dep.max()).clip(0, 1)

    # ---------- crop + grid mesh ----------
    g = rig.get('grid', 6)
    cover = dil(np.maximum(a_nw, wA) > 0.004, rig.get('meshGrow', 14)) & (gy < yc[None, :] + g)
    ys, xs = np.nonzero(cover)
    cx0, cy0 = max(0, xs.min() - 2 * g) // g * g, max(0, ys.min() - 2 * g) // g * g
    cx1, cy1 = min(W - 1, xs.max() + 2 * g), min(H - 1, ys.max() + 2 * g)
    nx, ny = (cx1 - cx0) // g + 2, (cy1 - cy0) // g + 2
    vx = cx0 + np.arange(nx) * g
    vy = cy0 + np.arange(ny) * g
    cellkeep = np.zeros((ny - 1, nx - 1), bool)
    cov_i = np.pad(cover, ((0, g * 2 + H), (0, g * 2 + W)))
    for j in range(ny - 1):
        for i in range(nx - 1):
            cellkeep[j, i] = cov_i[vy[j]:vy[j] + g + 1, vx[i]:vx[i] + g + 1].any()
    used = np.zeros((ny, nx), bool)
    used[:-1, :-1] |= cellkeep; used[1:, :-1] |= cellkeep; used[:-1, 1:] |= cellkeep; used[1:, 1:] |= cellkeep
    vid = np.full((ny, nx), -1, np.int64)
    vid[used] = np.arange(used.sum())
    VX, VY = np.meshgrid(vx, vy)
    px_, py_ = VX[used], VY[used]
    sx, sy = np.clip(px_, 0, W - 1), np.clip(py_, 0, H - 1)
    q8 = lambda m_: np.round(np.clip(m_[sy, sx], 0, 1) * 255).astype(np.uint8)
    attA = np.stack([q8(tailW), q8(tS), q8(earW[0]), q8(earW[1])], 1)
    attB = np.stack([q8(headW), q8(dep), q8(pawW), q8(whiskW)], 1)
    attC = np.stack([q8(breathW), q8(anchor), q8(np.zeros_like(anchor)), q8(np.zeros_like(anchor))], 1)
    tris = []
    jj, ii = np.nonzero(cellkeep)
    a00, a10, a01, a11 = vid[jj, ii], vid[jj, ii + 1], vid[jj + 1, ii], vid[jj + 1, ii + 1]
    idx = np.stack([a00, a01, a10, a10, a01, a11], 1).reshape(-1)
    nv = int(used.sum())
    idx = idx.astype(np.uint16 if nv < 65536 else np.uint32)
    pos = np.stack([px_, py_], 1).astype(np.uint16)
    blob = bytearray()
    offs = {}
    for name, arr in [('pos', pos), ('A', attA), ('B', attB), ('C', attC), ('idx', idx)]:
        while len(blob) % 4:
            blob.append(0)
        offs[name] = len(blob)
        blob += arr.tobytes()
    open(os.path.join(out, 'mesh.bin'), 'wb').write(bytes(blob))

    # ---------- textures ----------
    tx0, ty0, tx1, ty1 = cx0, cy0, min(W, cx1 + g + 1), min(H, cy1 + g + 1)
    rgba = np.dstack([np.clip(Fcat, 0, 255), a_nw * 255])[ty0:ty1, tx0:tx1]
    cv2.imwrite(os.path.join(out, 'cat.png'), cv2.cvtColor(np.round(rgba).astype(np.uint8), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    cv2.imwrite(os.path.join(out, 'plate.jpg'), np.clip(plate[..., ::-1], 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, rig.get('jpegQ', 90)])
    ex0 = int(min(e['c'][0] - e['r'][0] for e in eyes)) - 4
    ex1 = int(max(e['c'][0] + e['r'][0] for e in eyes)) + 5
    ey0 = int(min(e['c'][1] - e['r'][1] for e in eyes)) - 4
    ey1 = int(max(e['c'][1] + e['r'][1] for e in eyes)) + 5
    # highlight colour chosen so that mix(Fcat, rgb, hlm) == src exactly (eye region pixel-identical at rest)
    eye_rgb = np.where(hlm[..., None] > 0.02, np.clip((img - (1 - hlm[..., None]) * Fcat) / np.maximum(hlm, 0.02)[..., None], 0, 255), img)
    eye_rgba = np.dstack([eye_rgb, hlm * 255])[ey0:ey1, ex0:ex1]
    cv2.imwrite(os.path.join(out, 'eyes.png'), cv2.cvtColor(np.round(eye_rgba).astype(np.uint8), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])

    wb = np.array(rig.get('whiskerBoxes', [[0, 0, 2, 2]]))
    wx0, wy0 = max(0, int(wb[:, 0].min()) - 4), max(0, int(wb[:, 1].min()) - 4)
    wx1, wy1 = min(W, int(wb[:, 2].max()) + 4), min(H, int(wb[:, 3].max()) + 4)
    wl = np.dstack([Wc, wA * 255])[wy0:wy1, wx0:wx1]
    cv2.imwrite(os.path.join(out, 'whisk.png'), cv2.cvtColor(np.round(np.clip(wl, 0, 255)).astype(np.uint8), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    pk = {
        'src': rig['src'], 'size': [W, H], 'crop': [int(tx0), int(ty0), int(tx1 - tx0), int(ty1 - ty0)], 'eyeCrop': [ex0, ey0, ex1 - ex0, ey1 - ey0],
        'mesh': {'nv': nv, 'ni': int(idx.size), 'idx32': bool(nv >= 65536), 'offs': offs, 'bytes': len(blob)},
        'eyes': [{'c': e['c'], 'r': e['r'], 'rot': e.get('rot', 0), 'pupil': e.get('pupil', [0, 0]), 'meet': e.get('meet', 0.6),
                  'lidUp': e.get('lidUp', 0.3), 'lidLo': e.get('lidLo', 0.07)} for e in eyes],
        'ears': [{'pivot': e['base'], 'tip': e['tip']} for e in rig['ears']],
        'tail': np.round(joints, 2).tolist(), 'tailLen': round(float(Lt), 1),
        'whiskCrop': [wx0, wy0, wx1 - wx0, wy1 - wy0], 'whiskRamp': rig.get('whiskRamp', 160),
        'lidMargin': rig.get('lidMargin', 0.28),
        'nose': rig['nose'], 'neck': rig['neck'], 'whiskerRoots': rig['whiskerRoots'], 'paw': rig['paw'],
        'contactY': round(float(np.median(yc[int(x0p) - 300:int(x1p)])), 1),
        'faceC': [round((eyes[0]['c'][0] + eyes[1]['c'][0]) / 2, 1), round((eyes[0]['c'][1] + eyes[1]['c'][1]) / 2, 1)],
    }
    json.dump(pk, open(os.path.join(out, 'pack.json'), 'w'), indent=1)

    # ---------- debug ----------
    mag = np.array([255, 0, 255], F32)
    comp = Fcat * a_nw[..., None] + mag * (1 - a_nw[..., None])
    comp = comp * (1 - wA[..., None]) + Wc * wA[..., None]
    cv2.imwrite(os.path.join(DBG, f'{tag}_matte.png'), np.clip(comp[..., ::-1], 0, 255).astype(np.uint8))
    cv2.imwrite(os.path.join(DBG, f'{tag}_plate.png'), np.clip(plate[..., ::-1], 0, 255).astype(np.uint8))
    ov = img.copy() * 0.6
    ov[..., 0] += tailW * 100; ov[..., 1] += headW * 60; ov[..., 2] += (earW[0] + earW[1]) * 120
    ov[..., 1] += whiskW * 150; ov[..., 0] += pawW * 80; ov[..., 2] += pawW * 80
    ov = np.ascontiguousarray(np.clip(ov[..., ::-1], 0, 255).astype(np.uint8))
    for x in range(0, W - 1, 4):
        cv2.line(ov, (x, int(yc[x])), (x + 4, int(yc[min(W - 1, x + 4)])), (0, 255, 255), 2)
        if top is not None:
            cv2.circle(ov, (x, int(top[x])), 1, (0, 128, 255), -1)
    for e in eyes:
        cv2.ellipse(ov, (int(e['c'][0]), int(e['c'][1])), (int(e['r'][0]), int(e['r'][1])), e.get('rot', 0), 0, 360, (0, 255, 0), 1)
    for e in rig['ears']:
        cv2.line(ov, tuple(map(int, e['base'])), tuple(map(int, e['tip'])), (255, 255, 0), 2)
    for p in joints:
        cv2.circle(ov, (int(p[0]), int(p[1])), 5, (255, 0, 255), -1)
    cv2.polylines(ov, [np.round(dense).astype(np.int32)], False, (255, 0, 255), 1)
    for p in [rig['nose'], rig['neck']] + rig['whiskerRoots']:
        cv2.circle(ov, (int(p[0]), int(p[1])), 6, (0, 0, 255), 2)
    for bx in rig.get('whiskerBoxes', []):
        cv2.rectangle(ov, (bx[0], bx[1]), (bx[2], bx[3]), (0, 200, 255), 1)
    cv2.rectangle(ov, (int(x0p), int(y0p)), (int(x1p), int(y1p)), (255, 128, 0), 1)
    cv2.rectangle(ov, (tx0, ty0), (tx1, ty1), (128, 128, 128), 1)
    cv2.imwrite(os.path.join(DBG, f'{tag}_rig.png'), ov)
    dv = np.dstack([dep * 255, hlm * 255, wmask * 255]).astype(np.uint8)
    cv2.imwrite(os.path.join(DBG, f'{tag}_depth.png'), dv)
    sizes = {f: os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)}
    print('verts', nv, 'tris', idx.size // 3, 'crop', pk['crop'], 'sizes', sizes, 'total', sum(sizes.values()))


if __name__ == '__main__':
    main()
