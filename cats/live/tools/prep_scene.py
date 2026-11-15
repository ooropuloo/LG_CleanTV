#!/usr/bin/env python3
"""Offline prep for a v2 "living image" scene: several subjects (person + cat) in ONE continuous warp.

    python cats/live/tools/prep_scene.py <pack dir relative to tv-home>     e.g.  cats/heroine-live/morning

Unlike prep.py (cut-out cat over an inpainted plate), a v2 pack is the whole picture on one full-frame grid
mesh that the vertex shader bends with baked weights. Nothing is cut out, so nothing can tear, halo or
double; the price is that the surroundings stretch a little with each motion, so amplitudes stay small and
the weights are smooth. The faces sit inside regions of weight exactly 1 of a single rigid channel (owner
rule: faces never warp inside).

Reads  <pack>/rig.json (landmarks in source px, see NOTES.md "v2 scenes"), writes
       <pack>/assets/{image.jpg, eyes.png, aux.png?, mesh.bin, pack.json}
and debug images dev/shots/live/_dbg/<tag>_{rig,weights,aux}.png.  Deterministic.
"""
import sys, os, json, math
import numpy as np
import cv2
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prep as P  # noqa: E402  (shared helpers: pushpull, chaikin, resample, sstep, blur, dil, ero)

ROOT = P.ROOT
DBG = P.DBG
F32 = np.float32
sstep, blur, dil, ero = P.sstep, P.blur, P.dil, P.ero
NCH = 8          # affine channels (attributes A, B)


def fill(W, H, pts):
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(np.array(pts)).astype(np.int32)], 1)
    return m > 0


def polys(W, H, spec):
    """spec: one polygon [[x,y],...] or a list of them."""
    if not spec:
        return np.zeros((H, W), bool)
    if isinstance(spec[0][0], (int, float)):
        spec = [spec]
    m = np.zeros((H, W), bool)
    for p in spec:
        m |= fill(W, H, p)
    return m


def outside_falloff(mask, soft):
    """1 inside the mask, smooth fall to 0 at `soft` px outside (exactly 1 inside: rigid regions)."""
    if not mask.any():
        return np.zeros(mask.shape, F32)
    d = ndi.distance_transform_edt(~mask)
    return (1 - sstep(0, soft, d)).astype(F32)


def inside_ramp(mask, soft):
    """0 at the mask edge rising to 1 at `soft` px inside (a region that fades out at its border)."""
    d = ndi.distance_transform_edt(mask)
    return sstep(0, soft, d).astype(F32)


def ear_weight(gx, gy, e):
    tip, base = np.array(e['tip'], float), np.array(e['base'], float)
    ax = tip - base; Le = np.linalg.norm(ax); u = ax / Le; nrm = np.array([-u[1], u[0]])
    px, py = gx - base[0], gy - base[1]
    t = (px * u[0] + py * u[1]) / Le
    lat = np.abs(px * nrm[0] + py * nrm[1]) / (e.get('halfw', 0.5 * Le) * (1 - 0.55 * np.clip(t, 0, 1)) + 10)
    w = sstep(-0.1, 0.5, t) * (1 - sstep(0.85, 1.3, lat)) * (1 - sstep(1.15, 1.45, t))
    return blur(w, e.get('blur', 4)).astype(F32)


def tail_weight(W, H, tl, anchor):
    pts = P.chaikin(tl['points'], 3)
    K = tl.get('joints', 12)
    joints, Lt = P.resample(pts, K)
    dn, _ = P.resample(pts, 400)
    lbl = np.ones((H, W), np.uint8)
    idx_img = np.full((H, W), -1, np.int32)
    for i, p in enumerate(dn):
        xi, yi = int(round(p[0])), int(round(p[1]))
        if 0 <= xi < W and 0 <= yi < H:
            lbl[yi, xi] = 0
            idx_img[yi, xi] = i
    dist, (iy, ix) = ndi.distance_transform_edt(lbl, return_indices=True)
    tS = (idx_img[iy, ix] / 399.0).astype(F32)
    r0, r1 = tl['radius']
    radS = r0 + (r1 - r0) * tS
    w = 1 - sstep(radS + tl.get('in', 6), radS * 1.3 + tl.get('out', 30), dist)
    # fade in from the base (the part of the tail near the body barely moves)
    w *= sstep(0, tl.get('baseFade', 0.12), tS)
    if tl.get('mask'):
        w *= outside_falloff(polys(W, H, tl['mask']), tl.get('maskSoft', 10))
    w = blur(w, tl.get('blur', 3)) * anchor
    return w.astype(F32), tS, joints, Lt, dn


def eye_highlights(img, gray, gx, gy, e):
    cx, cy = e['c']; rx, ry = e['r']; ang = math.radians(e.get('rot', 0))
    H, W = gray.shape
    out = np.zeros((H, W), F32)
    dx, dy = gx - cx, gy - cy
    qx = (dx * math.cos(ang) + dy * math.sin(ang)) / rx
    qy = (-dx * math.sin(ang) + dy * math.cos(ang)) / ry
    x0, y0, x1, y1 = int(cx - rx - 2), int(cy - ry - 2), int(cx + rx) + 3, int(cy + ry) + 3
    L = gray[y0:y1, x0:x1]
    tr = max(2, int(max(rx, ry) * e.get('hlTr', 0.2)))
    toph = cv2.morphologyEx(L.astype(F32), cv2.MORPH_TOPHAT, P.disk(tr))
    satv = img[y0:y1, x0:x1].max(2) - img[y0:y1, x0:x1].min(2)
    cand = (toph > e.get('hlTop', 45)) & (L > e.get('hlMin', 160)) & (satv < e.get('hlSat', 70)) & \
           (qx[y0:y1, x0:x1] ** 2 + qy[y0:y1, x0:x1] ** 2 < e.get('hlR', 0.62) ** 2)
    lab, n = ndi.label(cand)
    keep = np.zeros(n + 1, bool)
    for i, sl_ in enumerate(ndi.find_objects(lab)):
        hh_, ww_ = sl_[0].stop - sl_[0].start, sl_[1].stop - sl_[1].start
        area = (lab[sl_] == i + 1).sum()
        keep[i + 1] = max(hh_, ww_) <= 0.5 * max(rx, ry) and max(hh_, ww_) <= 2.4 * max(1, min(hh_, ww_)) and area >= e.get('hlArea', 3)
    out[y0:y1, x0:x1] = keep[lab]
    return out


def main():
    pack = os.path.join(ROOT, sys.argv[1])
    rig = json.load(open(os.path.join(pack, 'rig.json'), encoding='utf-8'))
    out = os.path.join(pack, 'assets')
    os.makedirs(out, exist_ok=True)
    os.makedirs(DBG, exist_ok=True)
    tag = sys.argv[1].replace('cats/', '').replace('-live', '').replace('/', '_').replace('\\', '_')
    bgr = cv2.imread(os.path.join(ROOT, rig['src']), cv2.IMREAD_COLOR)
    img = bgr[..., ::-1].astype(F32)
    H, W = img.shape[:2]
    gray = img.mean(2)
    gy, gx = np.mgrid[0:H, 0:W].astype(F32)

    # ---------- anchor: contact line + pinned polygons (weights are 0 there) ----------
    c = rig.get('contact')
    if c:
        p = np.array(c['points'], float)
        yc = np.interp(np.arange(W), p[:, 0], p[:, 1]).astype(F32)
        anchor = sstep(0, c.get('band', 12), yc[None, :] - gy)
    else:
        yc = np.full(W, H, F32)
        anchor = np.ones((H, W), F32)
    for pin in rig.get('pins', []):
        anchor = anchor * (1 - outside_falloff(polys(W, H, pin['poly']), pin.get('band', 20)))
    # the picture border never moves (otherwise the black scene background would show at the frame edge)
    bd = rig.get('border', 24)
    border = (sstep(0, bd, gx) * sstep(0, bd, W - 1 - gx) * sstep(0, bd, gy) * sstep(0, bd, H - 1 - gy)).astype(F32)
    anchor = (anchor * border).astype(F32)

    chans, chW = [], []          # affine channels: meta + weight map
    tail = None; tailW = tS = None
    hairW = np.zeros((H, W), F32); hairPh = np.zeros((H, W), F32); hair_meta = None
    subjects, eyes_all = [], []
    face_masks = []
    for S in rig['subjects']:
        sid, kind = S['id'], S['kind']
        sub = {'id': sid, 'kind': kind, 'eyes': [], 'gaze': S.get('gaze', True), 'ch': {}}
        face = polys(W, H, S['face'])
        face_masks.append(face)
        headW = outside_falloff(face, S.get('faceSoft', 30))
        # breath
        br = S.get('breath')
        if br:
            bm = polys(W, H, br['poly'])
            if kind == 'person':
                # vertical rise growing from y0 (resting arms) to y1 (shoulders), constant above (face rigid)
                bw = sstep(br['y0'], br['y1'], gy) if br['y1'] > br['y0'] else sstep(-br['y0'], -br['y1'], -gy)
                bw = bw * outside_falloff(bm, br.get('soft', 30))
                bw = np.maximum(bw, headW)                  # head rides the breath rigidly
            else:
                bw = inside_ramp(bm, br.get('soft', 25)) * (1 - headW) if br.get('excludeFace', True) else inside_ramp(bm, br.get('soft', 25))
            sub['ch']['breath'] = len(chans)
            chans.append({'kind': 'breath', 'subject': sid, 'pivot': br.get('pivot', S['neck'])})
            chW.append(blur(bw, br.get('blur', 3)) * anchor)
        sub['ch']['head'] = len(chans)
        chans.append({'kind': 'head', 'subject': sid, 'pivot': S['neck']})
        chW.append(headW * anchor)
        # ears
        for side, e in zip(('earL', 'earR'), S.get('ears', [])):
            sub['ch'][side] = len(chans)
            chans.append({'kind': side, 'subject': sid, 'pivot': e['base'], 'tip': e['tip']})
            chW.append(ear_weight(gx, gy, e) * anchor)
        # paw (bat around the wrist): weight ramps from the elbow (0) to the wrist (1)
        pw = S.get('paw')
        if pw:
            pm = polys(W, H, pw['poly'])
            b, wr = np.array(pw['base'], float), np.array(pw['pivot'], float)
            ax = wr - b; La = np.linalg.norm(ax)
            t = ((gx - b[0]) * ax[0] + (gy - b[1]) * ax[1]) / (La * La)
            w = sstep(0.0, 1.0, t) * outside_falloff(pm, pw.get('soft', 18))
            sub['ch']['paw'] = len(chans)
            chans.append({'kind': 'paw', 'subject': sid, 'pivot': pw['pivot'], 'base': pw['base'], 'tip': pw.get('tip', pw['pivot'])})
            chW.append(blur(w, 3) * (anchor if pw.get('anchored', True) else 1))
        yn = S.get('yarn')
        if yn:
            r = yn['r']
            w = 1 - sstep(r * 0.92, r * 1.0 + yn.get('soft', 18), np.hypot(gx - yn['c'][0], gy - yn['c'][1]))
            sub['ch']['yarn'] = len(chans)
            chans.append({'kind': 'yarn', 'subject': sid, 'pivot': yn['pivot'], 'c': yn['c'], 'r': r})
            chW.append((blur(w, 2) * border).astype(F32))
        # tail (one per scene)
        if S.get('tail'):
            tailW, tS, joints, Lt, dn = tail_weight(W, H, S['tail'], anchor)
            tail = {'subject': sid, 'joints': np.round(joints, 2).tolist(), 'len': round(float(Lt), 1)}
            tail_dense = dn
        # hair: weight along the strands, 0 at the root line (and on the face), 1 toward the ends
        for hh in S.get('hair', []):
            hm = polys(W, H, hh['poly'])
            w = sstep(hh['root'], hh['tip'], gy) * inside_ramp(hm, hh.get('soft', 14))
            w = w * (1 - outside_falloff(face, hh.get('faceGap', 25)))
            hairW = np.maximum(hairW, blur(w, 3).astype(F32))
            hair_meta = {'subject': sid}
        for e in S['eyes']:
            sub['eyes'].append(len(eyes_all))
            eyes_all.append(e)
        sub['faceC'] = [round(float(np.mean([e['c'][0] for e in S['eyes']])), 1), round(float(np.mean([e['c'][1] for e in S['eyes']])), 1)] if S['eyes'] else S['neck']
        subjects.append(sub)
    # a subject's motion must not drag a neighbour's face: zero every channel on the other faces
    for i, ch in enumerate(chans):
        si = [s['id'] for s in subjects].index(ch['subject'])
        for j, fm in enumerate(face_masks):
            if j != si:
                chW[i] = chW[i] * (1 - outside_falloff(fm, 12))
    if tail is not None:
        si = [s['id'] for s in subjects].index(tail['subject'])
        for j, fm in enumerate(face_masks):
            if j != si:
                tailW = tailW * (1 - outside_falloff(fm, 12))
    for j, fm in enumerate(face_masks):
        if rig['subjects'][j].get('hair') is None:
            hairW = hairW * (1 - outside_falloff(fm, 20))
    for ex in rig.get('hairExclude', []):
        hairW = hairW * (1 - outside_falloff(polys(W, H, ex), 16))
    hairW = hairW * anchor
    assert len(chans) <= NCH, 'too many channels'

    # ---------- eyes: specular highlights out of the warped picture ----------
    hl = np.zeros((H, W), F32)
    for e in eyes_all:
        hl = np.maximum(hl, eye_highlights(img, gray, gx, gy, dict(rig.get('hl', {}), **e)))
    hlm = blur(dil(hl > 0.5, 1), 0.8).clip(0, 1)
    base = img.copy()
    if hlm.max() > 0:
        inp = P.pushpull(img, ~dil(hlm > 0.03, 2))
        hk = blur(dil(hlm > 0.03, 2), 1.0)[..., None]
        base = img * (1 - hk) + inp * hk
    eye_rgb = np.where(hlm[..., None] > 0.02, np.clip((img - (1 - hlm[..., None]) * base) / np.maximum(hlm, 0.02)[..., None], 0, 255), img)
    if hlm.max() > 0.02:
        eye_rgb = P.pushpull(eye_rgb, hlm > 0.02)      # smooth colour outside the highlights (compresses, no dark edges)
    else:
        eye_rgb = np.zeros_like(eye_rgb)
    if eyes_all:
        ex0 = int(min(e['c'][0] - max(e['r']) for e in eyes_all)) - 4
        ex1 = int(max(e['c'][0] + max(e['r']) for e in eyes_all)) + 5
        ey0 = int(min(e['c'][1] - max(e['r']) for e in eyes_all)) - 4
        ey1 = int(max(e['c'][1] + max(e['r']) for e in eyes_all)) + 5
    else:
        ex0, ey0, ex1, ey1 = 0, 0, 4, 4
    eye_rgba = np.dstack([eye_rgb, hlm * 255])[ey0:ey1, ex0:ex1]
    cv2.imwrite(os.path.join(out, 'eyes.png'), cv2.cvtColor(np.round(eye_rgba).astype(np.uint8), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    cv2.imwrite(os.path.join(out, 'image.jpg'), np.clip(base[..., ::-1], 0, 255).astype(np.uint8), [cv2.IMWRITE_JPEG_QUALITY, rig.get('jpegQ', 90)])

    # ---------- fx (animated texture regions) -> aux.png (half res): R bokeh, G bokeh phase, B rain, A lamp ----------
    fx = rig.get('fx') or {}
    aux = None
    fx_box = None
    if fx:
        aux = np.zeros((H, W, 4), F32)
        fxEx = 1 - outside_falloff(polys(W, H, fx.get('exclude', [])), fx.get('excludeSoft', 8))   # subjects in front of the window
        if fx.get('bokeh'):
            bk = fx['bokeh']
            reg = polys(W, H, bk['poly'])
            r_, g_, b_ = img[..., 0], img[..., 1], img[..., 2]
            warm = (r_ > b_ + bk.get('warm', 40)) & (gray > bk.get('min', 90))
            loc = gray - cv2.GaussianBlur(gray, (0, 0), bk.get('bgSigma', 14))
            m = warm & (loc > bk.get('loc', 8)) & reg
            m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, P.disk(1)) > 0
            lab, n = ndi.label(dil(m, 2))
            rs = np.random.RandomState(5)
            phase = np.concatenate([[0], rs.rand(n)]).astype(F32)
            strength = blur(m, 2.5) * sstep(bk.get('min', 90), bk.get('min', 90) + 80, gray)
            aux[..., 0] = np.clip(strength * 1.6, 0, 1) * fxEx
            aux[..., 1] = blur(phase[lab], 1.5)
        if fx.get('rain'):
            rm = polys(W, H, fx['rain']['poly'])
            aux[..., 2] = blur(ero(rm, 3), 3) * fxEx
        if fx.get('lamp'):
            lp = fx['lamp']
            d = np.hypot((gx - lp['c'][0]) / lp['r'][0], (gy - lp['c'][1]) / lp['r'][1])
            aux[..., 3] = (1 - sstep(0.0, 1.0, d)) * sstep(lp.get('min', 40), lp.get('min', 40) + 120, gray)
        nz = np.argwhere(aux.max(2) > 0.002)
        fx_box = [int(nz[:, 1].min()) - 4, int(nz[:, 0].min()) - 4, int(nz[:, 1].max()) + 4, int(nz[:, 0].max()) + 4] if len(nz) else [-1, -1, -1, -1]
        small = cv2.resize(aux, (W // 2, H // 2), interpolation=cv2.INTER_AREA)
        cv2.imwrite(os.path.join(out, 'aux.png'), cv2.cvtColor(np.round(small * 255).astype(np.uint8), cv2.COLOR_RGBA2BGRA), [cv2.IMWRITE_PNG_COMPRESSION, 9])
    elif os.path.exists(os.path.join(out, 'aux.png')):
        os.remove(os.path.join(out, 'aux.png'))

    # ---------- full-frame grid mesh ----------
    g = rig.get('grid', 8)
    vx = np.arange(0, W + g, g); vx[-1] = min(vx[-1], W)
    vy = np.arange(0, H + g, g); vy[-1] = min(vy[-1], H)
    VX, VY = np.meshgrid(vx, vy)
    nx, ny = len(vx), len(vy)
    sx, sy = np.clip(VX, 0, W - 1).ravel(), np.clip(VY, 0, H - 1).ravel()
    q8 = lambda m_: np.round(np.clip(m_[sy, sx], 0, 1) * 255).astype(np.uint8)
    zero = np.zeros((H, W), F32)
    cw = chW + [zero] * (NCH - len(chW))
    attA = np.stack([q8(cw[i]) for i in range(4)], 1)
    attB = np.stack([q8(cw[i]) for i in range(4, 8)], 1)
    tW = tailW if tailW is not None else zero
    tSS = tS if tS is not None else zero
    # hair phase: varies across the strands (x) so neighbouring locks do not move in lockstep
    hairPh = ((gx * 0.011 + np.sin(gx * 0.031) * 0.15) % 1.0).astype(F32)
    attC = np.stack([q8(tW), q8(tSS), q8(hairW), q8(hairPh)], 1)
    vid = np.arange(nx * ny).reshape(ny, nx)
    a00, a10, a01, a11 = vid[:-1, :-1].ravel(), vid[:-1, 1:].ravel(), vid[1:, :-1].ravel(), vid[1:, 1:].ravel()
    idx = np.stack([a00, a01, a10, a10, a01, a11], 1).reshape(-1)
    nv = nx * ny
    idx = idx.astype(np.uint16 if nv < 65536 else np.uint32)
    pos = np.stack([VX.ravel(), VY.ravel()], 1).astype(np.uint16)
    blob = bytearray(); offs = {}
    for name, arr in [('pos', pos), ('A', attA), ('B', attB), ('C', attC), ('idx', idx)]:
        while len(blob) % 4:
            blob.append(0)
        offs[name] = len(blob)
        blob += arr.tobytes()
    open(os.path.join(out, 'mesh.bin'), 'wb').write(bytes(blob))

    pk = {
        'version': 2, 'src': rig['src'], 'size': [W, H], 'grade': rig.get('grade', 1.0),
        'mesh': {'nv': int(nv), 'ni': int(idx.size), 'idx32': bool(nv >= 65536), 'offs': offs, 'bytes': len(blob)},
        'eyeCrop': [ex0, ey0, ex1 - ex0, ey1 - ey0],
        'eyes': [{'c': e['c'], 'r': e['r'], 'rot': e.get('rot', 0), 'pupil': e.get('pupil', [0, 0]),
                  'fall': e.get('fall', [0.45, 0.96]), 'shift': e.get('shift', 1.0)} for e in eyes_all],
        'channels': chans, 'subjects': subjects, 'tail': tail, 'hair': hair_meta,
        'fx': {k: True for k in fx if k in ('rain', 'bokeh', 'lamp')} if fx else {}, 'aux': bool(fx), 'fxBox': fx_box,
        'swat': rig.get('swat'),
    }
    json.dump(pk, open(os.path.join(out, 'pack.json'), 'w'), indent=1)

    # ---------- debug ----------
    ov = img.copy() * 0.55
    cols = [(255, 80, 80), (80, 255, 80), (80, 80, 255), (255, 255, 0), (255, 0, 255), (0, 255, 255), (255, 160, 0), (160, 0, 255)]
    for i, w in enumerate(chW):
        ov += w[..., None] * np.array(cols[i], F32)[None, None] * 0.35
    if tailW is not None:
        ov[..., 0] += tailW * 120; ov[..., 2] += tailW * 120
    ov[..., 1] += hairW * 140
    ov = np.ascontiguousarray(np.clip(ov[..., ::-1], 0, 255).astype(np.uint8))
    if c:
        for x in range(0, W - 1, 4):
            cv2.line(ov, (x, int(yc[x])), (x + 4, int(yc[min(W - 1, x + 4)])), (0, 255, 255), 1)
    for e in eyes_all:
        cv2.ellipse(ov, (int(e['c'][0]), int(e['c'][1])), (int(e['r'][0]), int(e['r'][1])), e.get('rot', 0), 0, 360, (0, 255, 0), 1)
    for S in rig['subjects']:
        for poly_ in ([S['face']] if isinstance(S['face'][0][0], (int, float)) else S['face']):
            cv2.polylines(ov, [np.round(np.array(poly_)).astype(np.int32)], True, (255, 255, 255), 1)
        cv2.circle(ov, tuple(map(int, S['neck'])), 5, (0, 0, 255), 2)
        for e in S.get('ears', []):
            cv2.line(ov, tuple(map(int, e['base'])), tuple(map(int, e['tip'])), (255, 255, 0), 2)
        if S.get('tail'):
            cv2.polylines(ov, [np.round(tail_dense).astype(np.int32)], False, (255, 0, 255), 1)
            for p_ in tail['joints']:
                cv2.circle(ov, (int(p_[0]), int(p_[1])), 4, (255, 0, 255), -1)
        if S.get('paw'):
            cv2.circle(ov, tuple(map(int, S['paw']['pivot'])), 6, (0, 128, 255), 2)
            cv2.circle(ov, tuple(map(int, S['paw']['base'])), 6, (0, 128, 255), 1)
        for hh in S.get('hair', []):
            cv2.polylines(ov, [np.round(np.array(hh['poly'])).astype(np.int32)], True, (0, 255, 0), 1)
    cv2.imwrite(os.path.join(DBG, f'{tag}_rig.png'), ov)
    if aux is not None:
        cv2.imwrite(os.path.join(DBG, f'{tag}_aux.png'), np.clip(img[..., ::-1] * 0.4 + aux[..., [2, 3, 0]] * 255 * 0.8, 0, 255).astype(np.uint8))
    sizes = {f: os.path.getsize(os.path.join(out, f)) for f in os.listdir(out)}
    print(tag, 'verts', nv, 'tris', idx.size // 3, 'channels', [ch['kind'] + ':' + ch['subject'] for ch in chans],
          'highlights', int((hl > 0).sum()), 'sizes', sizes, 'total', sum(sizes.values()))


if __name__ == '__main__':
    main()
