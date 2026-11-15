"""Offline "max deformation" check for a v2 pack: re-implements engine2.js extremes() on the CPU from the pack's own
mesh.bin + pack.json + motion, renders both extreme poses, and measures what can go wrong:

- fold / tear: Jacobian determinant of the forward map (should stay near 1; < 0.6 = squashed, < 0 = folded)
- face rigidity: displacement inside each face (eroded, minus ears/eyes) must be a rigid motion (RMS residual)
- drag: how much of the picture outside the subjects moves more than 2 px
- eye warp: the fragment-shader eye shift, applied the same way (iris moves, rim stays)

Outputs metrics + debug images (extreme A/B, motion heat map, face close-ups) for the vision review.
"""
import json
import math
import os
import cv2
import numpy as np

NJ, NCH = 12, 8
PERSON = dict(eyeShift=[0.16, 0.0], breath=1.6, roll=0.0035, yawShift=1.0, bob=0.5, tilt=0.006, hair=2.2, hairY=0.6, hairK=0.012)
CAT = dict(eyeShift=[0.2, 0.12], breath=0.006, breathY=1.0, roll=0.004, yawShift=1.4, bob=0.7, tilt=0.01,
           earTwitch=0.14, earGaze=0.03, tailAmp=0.03, tailDrift=0.02, flick=0.14, paw=0, yarn=0, headRide=1)


def _mot(kind, sid, motion):
    M = dict(PERSON if kind == 'person' else CAT)
    M.update(motion.get(kind, {}))
    M.update(motion.get(sid, {}))
    return M


def load(assets):
    pk = json.load(open(os.path.join(assets, 'pack.json')))
    b = open(os.path.join(assets, 'mesh.bin'), 'rb').read()
    m, o = pk['mesh'], pk['mesh']['offs']
    nv = m['nv']
    pos = np.frombuffer(b, np.uint16, nv * 2, o['pos']).reshape(nv, 2).astype(np.float64)
    A = np.frombuffer(b, np.uint8, nv * 4, o['A']).reshape(nv, 4) / 255.0
    B = np.frombuffer(b, np.uint8, nv * 4, o['B']).reshape(nv, 4) / 255.0
    C = np.frombuffer(b, np.uint8, nv * 4, o['C']).reshape(nv, 4) / 255.0
    return pk, pos, np.concatenate([A, B], 1), C


def extremes_disp(pk, pos, Wc, C, motion, sg):
    """Per-vertex displacement (nv, 2) for extremes() pose with side sg (+1/-1). Mirrors engine2.js."""
    chans = pk['channels']
    Mx = np.tile(np.array([1.0, 0, 0, 1]), (NCH, 1)); T = np.zeros((NCH, 2))

    def setrot(i, px, py, a, tx, ty, sx=1.0, sy=1.0):
        if i is None:
            return
        c, s = math.cos(a), math.sin(a)
        m00, m01, m10, m11 = c * sx, -s * sy, s * sx, c * sy
        Mx[i] = [m00, m01, m10, m11]
        T[i] = [px - (m00 * px + m01 * py) + tx, py - (m10 * px + m11 * py) + ty]

    def disp(i, x, y):
        return Mx[i][0] * x + Mx[i][1] * y + T[i][0] - x, Mx[i][2] * x + Mx[i][3] * y + T[i][1] - y

    eyeG = {}
    hair = None
    for s in pk['subjects']:
        M = _mot(s['kind'], s['id'], motion)
        ch = s['ch']
        for e in s['eyes']:
            eyeG[e] = (sg * M['eyeShift'][0] * pk['eyes'][e]['shift'], M['eyeShift'][1] * pk['eyes'][e]['shift'], 1.25, 1.25)
        if ch.get('breath') is not None:
            pv = chans[ch['breath']]['pivot']
            if s['kind'] == 'person':
                setrot(ch['breath'], pv[0], pv[1], 0, 0, -M['breath'] * 1.2)
            else:
                setrot(ch['breath'], pv[0], pv[1], 0, 0, 0, 1 + M['breath'] * 0.5, 1 + M['breath'] * M['breathY'] * 1.2)
        neck = chans[ch['head']]['pivot']
        hx, hy = sg * (M['bob'] * 0.4 + M['yawShift']), M['bob'] + M['yawShift'] * 0.5
        if s['kind'] != 'person' and ch.get('breath') is not None:
            dx, dy = disp(ch['breath'], neck[0], neck[1]); hx += dx; hy += dy
        setrot(ch['head'], neck[0], neck[1], sg * (M['roll'] + M['tilt']), hx, hy)
        if s['kind'] == 'person' and pk.get('hair'):
            hair = (M['hair'] * sg, 1.5708, M['hairK'], M['hairY'])
        if ch.get('earL') is not None:
            a = M['earTwitch'] * 0.62 + M['earGaze']
            pl, pr = chans[ch['earL']]['pivot'], chans[ch['earR']]['pivot']
            setrot(ch['earL'], pl[0], pl[1], -sg * a, 0, 0); setrot(ch['earR'], pr[0], pr[1], sg * a, 0, 0)
        if ch.get('paw') is not None:
            pv = chans[ch['paw']]['pivot']; setrot(ch['paw'], pv[0], pv[1], -sg * M['paw'] * 1.35, 0, 0)
    x, y = pos[:, 0], pos[:, 1]
    d = np.zeros_like(pos)
    for i in range(NCH):
        w = Wc[:, i]
        if not w.any():
            continue
        d[:, 0] += w * (Mx[i][0] * x + Mx[i][1] * y + T[i][0] - x)
        d[:, 1] += w * (Mx[i][2] * x + Mx[i][3] * y + T[i][1] - y)
    tl = pk.get('tail')
    if tl:
        J = np.array(tl['joints'], float)
        ts = [s for s in pk['subjects'] if s['id'] == tl['subject']][0]
        M = _mot(ts['kind'], ts['id'], motion)
        seg = np.diff(J, axis=0)
        acc, ax, ay = 0.0, J[0][0], J[0][1]
        JA, JD = np.zeros(NJ), np.zeros((NJ, 2))
        for j in range(NJ):
            s_ = j / (NJ - 1)
            acc += sg * (0.3 if j == 0 else 1) * ((M['tailAmp'] + 1.5 * M['tailDrift']) * (0.25 + 0.75 * s_) + M['flick'] * 0.55 * s_ * s_)
            JA[j] = acc; JD[j] = [ax, ay]
            if j < NJ - 1:
                c, sn = math.cos(acc), math.sin(acc)
                ax += c * seg[j][0] - sn * seg[j][1]; ay += sn * seg[j][0] + c * seg[j][1]
        w = C[:, 0]
        on = w > 0.002
        sS = C[on, 1] * (NJ - 1)
        j = np.minimum(np.floor(sS), NJ - 2).astype(int)
        f = sS - j
        p = pos[on]

        def rot(v, a):
            c, s = np.cos(a), np.sin(a)
            return np.stack([c * v[:, 0] - s * v[:, 1], s * v[:, 0] + c * v[:, 1]], 1)
        pa = JD[j] + rot(p - J[j], JA[j])
        pb = JD[j + 1] + rot(p - J[j + 1], JA[j + 1])
        d[on] += w[on, None] * ((pa * (1 - f[:, None]) + pb * f[:, None]) - p)
    if hair is not None:
        on = C[:, 2] > 0.002
        ph = hair[1] + C[on, 3] * 6.2832 - pos[on, 1] * hair[2]
        d[on, 0] += C[on, 2] * hair[0] * np.sin(ph)
        d[on, 1] += C[on, 2] * hair[3] * np.sin(ph * 0.7 + 1.3)
    return d, eyeG


def render(img, pk, pos, d, eyeG):
    """CPU render: displacement field on the 8 px grid -> full-res inverse map (fixed point) -> eye warp -> remap."""
    H, W = img.shape[:2]
    xs = np.unique(pos[:, 0]); ys = np.unique(pos[:, 1])
    nx, ny = len(xs), len(ys)
    D = d.reshape(ny, nx, 2).astype(np.float32)
    gy, gx = np.mgrid[0:H, 0:W].astype(np.float32)
    # vertex coordinate -> grid index (the last column/row may be shorter than 8 px)
    ix = np.interp(np.arange(W), xs, np.arange(nx)).astype(np.float32)
    iy = np.interp(np.arange(H), ys, np.arange(ny)).astype(np.float32)

    def field(sx, sy):
        mx = np.interp(sx.ravel(), xs, np.arange(nx)).reshape(sx.shape).astype(np.float32)
        my = np.interp(sy.ravel(), ys, np.arange(ny)).reshape(sy.shape).astype(np.float32)
        return cv2.remap(D, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    Dfull = cv2.remap(D, np.tile(ix, (H, 1)), np.tile(iy[:, None], (1, W)), cv2.INTER_LINEAR)
    sx, sy = gx.copy(), gy.copy()
    for _ in range(5):
        f = field(sx, sy)
        sx, sy = gx - f[..., 0], gy - f[..., 1]
    # eyes (fragment shader): q in eye space, shift the iris with falloff to the rim
    for e, E in enumerate(pk['eyes']):
        if e not in eyeG:
            continue
        cx, cy = E['c']; rx, ry = E['r']; a = math.radians(E['rot'])
        ca, sa = math.cos(a), math.sin(a)
        dx, dy = sx - cx, sy - cy
        qx = (ca * dx + sa * dy) / rx; qy = (-sa * dx + ca * dy) / ry
        rho = np.sqrt(qx * qx + qy * qy)
        m = rho < 1.0
        if not m.any():
            continue
        f0, f1 = E['fall']
        t = np.clip((rho - f0) / (f1 - f0), 0, 1); fall = 1 - t * t * (3 - 2 * t)
        G = eyeG[e]
        qex, qey = qx - G[0] * fall, qy - G[1] * fall
        px_, py_ = E['pupil']
        dqx, dqy = qex - px_, qey - py_
        L = np.sqrt(dqx * dqx + dqy * dqy)
        t2 = np.clip((L - 0.2) / (0.72 - 0.2), 0, 1); fp = 1 - t2 * t2 * (3 - 2 * t2)
        qex = px_ + dqx / (1 + (G[2] - 1) * fp); qey = py_ + dqy / (1 + (G[3] - 1) * fp)
        wx, wy = qex * rx, qey * ry
        ox, oy = cx + ca * wx - sa * wy, cy + sa * wx + ca * wy
        sx = np.where(m, ox, sx); sy = np.where(m, oy, sy)
    out = cv2.remap(img, sx.astype(np.float32), sy.astype(np.float32), cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    return out, Dfull


def tail_field(pos, C, H, W):
    """Full-res map of a per-vertex weight column (e.g. the tail weight)."""
    xs = np.unique(pos[:, 0]); ys = np.unique(pos[:, 1])
    T = C.reshape(len(ys), len(xs)).astype(np.float32)
    ix = np.interp(np.arange(W), xs, np.arange(len(xs))).astype(np.float32)
    iy = np.interp(np.arange(H), ys, np.arange(len(ys))).astype(np.float32)
    return cv2.remap(T, np.tile(ix, (H, 1)), np.tile(iy[:, None], (1, W)), cv2.INTER_LINEAR)


def _poly_mask(H, W, poly):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(np.array(poly)).astype(np.int32)], 1)
    return m > 0


def check(img, rig, assets, motion, dbg_prefix):
    H, W = img.shape[:2]
    pk, pos, Wc, C = load(assets)
    res = {'faces': [], 'frames': []}
    frames = []
    notail = tail_field(pos, C[:, 0], H, W) < 0.02
    # ears rotate about their base: judge them by angle (tip displacement / ear length), not by pixels
    ears = np.zeros((H, W), bool)
    ear_len = 1.0
    for i, ch in enumerate(pk['channels']):
        if ch['kind'] in ('earL', 'earR'):
            ears |= tail_field(pos, Wc[:, i], H, W) > 0.02
            ear_len = max(ear_len, math.hypot(ch['tip'][0] - ch['pivot'][0], ch['tip'][1] - ch['pivot'][1]))
    body = notail & ~ears
    for sg in (1, -1):
        d, eyeG = extremes_disp(pk, pos, Wc, C, motion, sg)
        out, Df = render(img, pk, pos, d, eyeG)
        frames.append(out)
        # Jacobian of the forward map p -> p + D(p)
        dxx = np.gradient(Df[..., 0], axis=1); dxy = np.gradient(Df[..., 0], axis=0)
        dyx = np.gradient(Df[..., 1], axis=1); dyy = np.gradient(Df[..., 1], axis=0)
        det = (1 + dxx) * (1 + dyy) - dxy * dyx
        mag = np.hypot(Df[..., 0], Df[..., 1])
        # a squash/fold on flat background is invisible; count it only where the picture has texture
        g = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.5)
        tex = np.hypot(np.gradient(g, axis=1), np.gradient(g, axis=0))
        tex = cv2.dilate(tex, np.ones((5, 5), np.uint8))
        vis_fold = (det < 0.5) & (tex > 4.0)
        subj = np.zeros((H, W), bool)
        for S in rig['subjects']:
            subj |= _poly_mask(H, W, S['face'])
            if S.get('breath'):
                subj |= _poly_mask(H, W, S['breath']['poly'])
            for e in S.get('ears', []):
                cv2.line(subj.view(np.uint8), tuple(map(int, e['base'])), tuple(map(int, e['tip'])), 1, int(2 * e['halfw']))
            if S.get('tail'):
                tp = np.round(np.array(S['tail']['points'])).astype(np.int32)
                cv2.polylines(subj.view(np.uint8), [tp], False, 1, int(2 * S['tail']['radius'][0] + 2 * S['tail']['out']))
            for hh in S.get('hair', []):
                subj |= _poly_mask(H, W, hh['poly'])
        subj = cv2.dilate(subj.astype(np.uint8), np.ones((41, 41), np.uint8)) > 0
        fr = {'sg': sg, 'det_min': round(float(det.min()), 3), 'det_p001': round(float(np.percentile(det, 0.1)), 3),
              'max_disp': round(float(mag[body].max()), 1), 'ear_rel': round(float(mag[ears].max()) / ear_len if ears.any() else 0.0, 3), 'tail_disp': round(float(mag[~notail].max()) if (~notail).any() else 0.0, 1), 'vis_fold': round(float(vis_fold.mean()), 5), 'drag_frac': round(float(((mag > 2.0) & ~subj).mean()), 4)}
        # face rigidity: least-squares similarity fit of the displacement on the face core
        for S in rig['subjects']:
            fm = _poly_mask(H, W, S['face'])
            fm = cv2.erode(fm.astype(np.uint8), np.ones((9, 9), np.uint8)) > 0
            for e in S.get('ears', []):
                b, t = np.array(e['base']), np.array(e['tip'])
                # ear rotation weight reaches a bit below the ear base: exclude the ear zone
                cv2.line(fm.view(np.uint8), tuple(map(int, b - 0.25 * (t - b))), tuple(map(int, t)), 0, int(2.2 * e['halfw']))
            for e in S['eyes']:
                cv2.ellipse(fm.view(np.uint8), (int(e['c'][0]), int(e['c'][1])), (int(e['r'][0]) + 2, int(e['r'][1]) + 2), e['rot'], 0, 360, 0, -1)
            ys_, xs_ = np.nonzero(fm)
            if len(xs_) < 200:
                continue
            k = max(1, len(xs_) // 20000)
            xs_, ys_ = xs_[::k], ys_[::k]
            u, v = Df[ys_, xs_, 0], Df[ys_, xs_, 1]
            Amat = np.zeros((2 * len(xs_), 4)); bvec = np.concatenate([u, v])
            Amat[:len(xs_)] = np.stack([xs_, -ys_, np.ones_like(xs_), np.zeros_like(xs_)], 1)
            Amat[len(xs_):] = np.stack([ys_, xs_, np.zeros_like(xs_), np.ones_like(xs_)], 1)
            sol, *_ = np.linalg.lstsq(Amat, bvec, rcond=None)
            rr = Amat @ sol - bvec
            rr = np.hypot(rr[:len(xs_)], rr[len(xs_):])
            fr.setdefault('face_rms', {})[S['id']] = round(float(np.sqrt((rr ** 2).mean())), 3)
            fr.setdefault('face_max', {})[S['id']] = round(float(np.percentile(rr, 99.5)), 3)
        res['frames'].append(fr)
        if dbg_prefix:
            heat = cv2.applyColorMap(np.clip(mag * 25, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
            cv2.imwrite(f'{dbg_prefix}_heat{"A" if sg > 0 else "B"}.jpg', cv2.addWeighted(img, 0.45, heat, 0.55, 0))
            cv2.imwrite(f'{dbg_prefix}_ext{"A" if sg > 0 else "B"}.jpg', out, [cv2.IMWRITE_JPEG_QUALITY, 90])
    if dbg_prefix:
        # face close-ups A | rest | B, magnified, for the reviewer
        rows = []
        for S in rig['subjects']:
            f = np.array(S['face']); x0, y0 = f.min(0); x1, y1 = f.max(0)
            pad = 0.12 * (x1 - x0)
            x0, y0, x1, y1 = int(max(0, x0 - pad)), int(max(0, y0 - pad)), int(min(W, x1 + pad)), int(min(H, y1 + pad))
            crops = [frames[0][y0:y1, x0:x1], img[y0:y1, x0:x1], frames[1][y0:y1, x0:x1]]
            hh = 360
            crops = [cv2.resize(c_, (int(c_.shape[1] * hh / c_.shape[0]), hh)) for c_ in crops]
            rows.append(np.hstack([np.hstack([c_, np.full((hh, 6, 3), 255, np.uint8)]) for c_ in crops]))
        wmax = max(r.shape[1] for r in rows)         # same width per row (scaled, no black padding: reviewers read it as a glitch)
        rows = [cv2.resize(r, (wmax, int(round(r.shape[0] * wmax / r.shape[1])))) for r in rows]
        rows = [np.vstack([r, np.full((6, wmax, 3), 255, np.uint8)]) for r in rows]
        cv2.imwrite(f'{dbg_prefix}_faces.jpg', np.vstack(rows), [cv2.IMWRITE_JPEG_QUALITY, 90])
        # A/B flicker strip as a side-by-side for the reviewer
        sm = lambda a: cv2.resize(a, (836, 470), interpolation=cv2.INTER_AREA)
        cv2.imwrite(f'{dbg_prefix}_AB.jpg', np.hstack([sm(frames[0]), np.full((470, 8, 3), 255, np.uint8), sm(frames[1])]), [cv2.IMWRITE_JPEG_QUALITY, 88])
    return res


def verdict(res, limits=None):
    L = dict(vis_fold=0.002, face_rms=0.4, face_max=2.5, drag_frac=0.06, max_disp=25, tail_disp=130, ear_rel=0.22)
    L.update(limits or {})
    bad = []
    for fr in res['frames']:
        if fr['vis_fold'] > L['vis_fold']:
            bad.append(f"visible squash/fold ({fr['vis_fold'] * 100:.2f}% of the picture)")
        if fr['max_disp'] > L['max_disp']:
            bad.append(f"too much motion ({fr['max_disp']} px outside the tail and ears)")
        if fr.get('ear_rel', 0) > L['ear_rel']:
            bad.append(f"ears move too much ({fr['ear_rel']} of their length)")
        if fr['tail_disp'] > L['tail_disp']:
            bad.append(f"tail moves too far ({fr['tail_disp']} px)")
        if fr['drag_frac'] > L['drag_frac']:
            bad.append(f"background dragged ({fr['drag_frac'] * 100:.1f}% > 2px)")
        for sid, v in (fr.get('face_rms') or {}).items():
            if v > L['face_rms'] or fr['face_max'][sid] > L['face_max']:
                bad.append(f"{sid} face not rigid (rms {v}, p99.5 {fr['face_max'][sid]} px)")
    return sorted(set(bad))
