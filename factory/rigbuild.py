"""agy landmarks (0..1000 grid) -> v2 rig.json for cats/live/tools/prep_scene.py, with automatic refinement and
geometric validation. build(lm, img, recipe) -> (rig, issues, notes); any issue = reject this image.

Refinement:
- eyes: radial search for the dark outer rim of the eyeball, robust ellipse fit; falls back to a shrunk agy box
  (a slightly small ellipse only makes the iris travel less; a too-large one drags eyelid fur -> we never grow it).
- pupil: centroid of the darkest pixels inside the eye.
- ledge/contact line: snapped to the strongest horizontal edge near agy's line, median-smoothed.
"""
import math
import cv2
import numpy as np


def _P(q, W, H):
    return [q['x'] / 1000.0 * (W - 1), q['y'] / 1000.0 * (H - 1)]


def _poly(ps, W, H):
    return [_P(q, W, H) for q in (ps or [])]


def _inside(poly, pt, margin=0.0):
    c = np.array(poly, np.float32).reshape(-1, 1, 2)
    return cv2.pointPolygonTest(c, (float(pt[0]), float(pt[1])), True) >= margin


def _area(poly):
    return abs(cv2.contourArea(np.array(poly, np.float32))) if len(poly) >= 3 else 0.0


def _scale_poly(poly, k):
    p = np.array(poly, float)
    c = p.mean(0)
    return (c + (p - c) * k).tolist()


def _r(v, n=1):
    if isinstance(v, (list, tuple)):
        return [_r(x, n) for x in v]
    return round(float(v), n)


def _loops(pts):
    """True if a polyline turns back sharply (> 110 deg between segments) or crosses itself."""
    p = np.array(pts, float)
    d = np.diff(p, axis=0)
    for a, b in zip(d[:-1], d[1:]):
        ca = float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))
        if ca < math.cos(math.radians(110)):
            return True
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    for i in range(len(p) - 1):
        for j in range(i + 2, len(p) - 1):
            a, b, c, e = p[i], p[i + 1], p[j], p[j + 1]
            if cross(a, b, c) * cross(a, b, e) < 0 and cross(c, e, a) * cross(c, e, b) < 0:
                return True
    return False


# ------------------------------------------------------------------ eyes
def refine_eye(gray, c, r):
    """gray float32 (blurred). c=(x,y), r=(rx,ry) from the agy box. -> (c, r, rot, ok)
    Along 36 rays from the centre, take the INNERMOST strong bright->dark step between 0.55 and 1.25 of the box
    radius (the dark rim around the iris / eyeball; further out there are eyelid lines and fur), then a robust
    ellipse fit. The result never grows past 1.08x the box (too large = eyelid fur dragged by the gaze warp)."""
    H, W = gray.shape
    cx, cy = c
    rx, ry = r
    pts = []
    gy_, gx_ = np.gradient(gray)
    for k in range(36):
        th = 2 * math.pi * k / 36
        dx, dy = math.cos(th), math.sin(th)
        rr = 1.0 / math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2)
        ts = np.linspace(0.55 * rr, 1.25 * rr, 40)
        xs, ys = cx + dx * ts, cy + dy * ts
        ok = (xs >= 1) & (xs < W - 2) & (ys >= 1) & (ys < H - 2)
        if ok.sum() < 20:
            continue
        xs, ys, ts = xs[ok], ys[ok], ts[ok]
        xi, yi = np.round(xs).astype(int), np.round(ys).astype(int)
        d = gx_[yi, xi] * dx + gy_[yi, xi] * dy           # radial derivative (outward)
        dmin = d.min()
        if dmin > -2.0:
            continue
        # innermost local minimum that is at least 55% as strong as the strongest step on this ray
        idx = [i for i in range(len(d)) if d[i] <= 0.55 * dmin and (i == 0 or d[i] <= d[i - 1]) and (i == len(d) - 1 or d[i] <= d[i + 1])]
        i = idx[0] if idx else int(np.argmin(d))
        pts.append((xs[i], ys[i], ts[i] / rr))
    if len(pts) < 14:
        return c, r, 0.0, False
    a = np.array(pts)
    med = np.median(a[:, 2])
    keep = np.abs(a[:, 2] - med) < 0.15 * med
    if keep.sum() < 12:
        return c, r, 0.0, False
    (ex, ey), (w, h), ang = cv2.fitEllipse(a[keep, :2].astype(np.float32))
    ax, bx = w / 2.0, h / 2.0
    rot = ang
    if rot > 90:
        rot -= 180
    if abs(rot) > 45:                                       # keep rx roughly horizontal
        ax, bx = bx, ax
        rot = rot - 90 if rot > 0 else rot + 90
    rot = max(-20.0, min(20.0, rot))
    nr = (min(ax + 1.0, 1.08 * rx), min(bx + 1.0, 1.08 * ry))
    okk = (0.6 < nr[0] / rx and 0.6 < nr[1] / ry and math.hypot(ex - cx, ey - cy) < 0.25 * min(rx, ry)
           and 0.45 < nr[0] / nr[1] < 2.2)
    if not okk:
        return c, r, 0.0, False
    return (ex, ey), nr, rot, True


def pupil_of(gray, c, r, rot):
    H, W = gray.shape
    x0, x1 = int(max(0, c[0] - r[0])), int(min(W, c[0] + r[0] + 1))
    y0, y1 = int(max(0, c[1] - r[1])), int(min(H, c[1] + r[1] + 1))
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    a = math.radians(rot)
    dx, dy = xx - c[0], yy - c[1]
    qx = (dx * math.cos(a) + dy * math.sin(a)) / r[0]
    qy = (-dx * math.sin(a) + dy * math.cos(a)) / r[1]
    m = qx ** 2 + qy ** 2 < 0.8 ** 2
    if m.sum() < 30:
        return [0.0, 0.0]
    g = gray[y0:y1, x0:x1]
    t = np.percentile(g[m], 15)
    d = m & (g <= t)
    px, py = float(qx[d].mean()), float(qy[d].mean())
    return [round(max(-0.45, min(0.45, px)), 2), round(max(-0.45, min(0.45, py)), 2)]


# ------------------------------------------------------------------ ledge
def refine_ledge(gray, pts, W, H):
    """pts: [[x,y]...] from agy. Returns (points, notes). Snaps to the strongest vertical-gradient row nearby."""
    g = cv2.GaussianBlur(gray, (0, 0), 3)
    dy = np.abs(np.diff(g, axis=0))
    xs = np.linspace(0, W - 1, 13)
    ap = np.array(sorted(pts), float)
    ya = np.interp(xs, ap[:, 0], ap[:, 1])
    out, moved = [], 0
    for x, y in zip(xs, ya):
        x0, x1 = int(max(0, x - 40)), int(min(W, x + 40))
        y0, y1 = int(max(0, y - 0.05 * H)), int(min(H - 2, y + 0.05 * H))
        prof = dy[y0:y1, x0:x1].mean(1)
        if len(prof) < 5:
            out.append(y); continue
        i = int(np.argmax(prof))
        if prof[i] > 2.0 * np.median(prof) + 0.5:
            out.append(y0 + i); moved += 1
        else:
            out.append(y)
    out = np.array(out)
    med = np.array([np.median(out[max(0, i - 1):i + 2]) for i in range(len(out))])
    return [[_r(x, 0), _r(y, 0)] for x, y in zip(xs, med)], f'ledge snapped {moved}/13'


# ------------------------------------------------------------------ subjects
def cat_subject(c, W, H, gray, contact_y, want_open, issues, notes, sid='cat'):
    head = _poly(c['head_outline'], W, H)
    if len(head) < 8 or _area(head) < 0.01 * W * H:
        issues.append(f'{sid}: head outline missing/too small'); return None
    hx0, hy0 = np.min(head, 0); hx1, hy1 = np.max(head, 0)
    headW, headH = hx1 - hx0, hy1 - hy0
    nose, chin = _P(c['nose'], W, H), _P(c['chin'], W, H)
    S = {'id': sid, 'kind': 'cat'}
    eyes = []
    open_ = bool(c.get('eyes_open'))
    if want_open and not open_:
        issues.append(f'{sid}: eyes not open')
    for side in ('left_eye', 'right_eye'):
        b = c[side]
        x0, y0 = _P({'x': b['x0'], 'y': b['y0']}, W, H); x1, y1 = _P({'x': b['x1'], 'y': b['y1']}, W, H)
        cc, rr = ((x0 + x1) / 2, (y0 + y1) / 2), (abs(x1 - x0) / 2, abs(y1 - y0) / 2)
        if not _inside(head, cc, 0):
            issues.append(f'{sid}: {side} centre outside the head outline')
        if want_open:
            if min(rr) < 12:
                issues.append(f'{sid}: {side} too small ({rr[0]:.0f}x{rr[1]:.0f}px)')
            if max(rr) > 0.3 * headW:
                issues.append(f'{sid}: {side} implausibly large')
            c2, r2, rot, ok = refine_eye(gray, cc, rr)
            if not ok:
                c2, r2, rot = cc, (rr[0] * 0.85, rr[1] * 0.85), 0.0
            notes.append(f'{sid} {side} {"rim-fit" if ok else "box*0.85"} c={_r(c2, 0)} r={_r(r2, 0)} rot={rot:.0f}')
            eyes.append({'c': _r(list(c2)), 'r': _r(list(r2)), 'rot': _r(rot), 'pupil': pupil_of(gray, c2, r2, rot)})
    if eyes:
        (a, b) = eyes
        if a['c'][0] >= b['c'][0]:
            issues.append(f'{sid}: eyes in wrong order')
        sep = math.hypot(a['c'][0] - b['c'][0], a['c'][1] - b['c'][1])
        if sep < 1.6 * max(a['r'][0], b['r'][0]):
            issues.append(f'{sid}: eyes overlap')
        if max(a['r'][0], b['r'][0]) / max(1, min(a['r'][0], b['r'][0])) > 1.7:
            issues.append(f'{sid}: eye sizes differ a lot')
        if not (min(a['c'][1], b['c'][1]) < nose[1]):
            issues.append(f'{sid}: nose above the eyes')
    if not _inside(head, nose, -4):
        issues.append(f'{sid}: nose outside head')
    # face polygon: agy head outline grown a little (fur fuzz must be inside the rigid region), clipped above the ledge
    face = _scale_poly(head, 1.05)
    face = [[min(W - 1, max(0, x)), min(y, contact_y(x) - 14)] for x, y in face]
    for e in eyes:
        if not _inside(face, e['c'], max(e['r']) * 0.8):
            issues.append(f'{sid}: an eye is too close to the face edge')
    S['eyes'] = eyes
    S['gaze'] = bool(eyes)
    S['face'] = _r(face, 0)
    S['faceSoft'] = int(np.clip(0.06 * headW, 20, 40))
    neck_y = min(contact_y(chin[0]) - 2, chin[1] + 0.12 * headH)
    S['neck'] = _r([chin[0], neck_y], 0)
    ears = []
    for side in ('left_ear', 'right_ear'):
        e = c[side]
        tip, base = _P(e['tip'], W, H), _P(e['base'], W, H)
        L = math.hypot(tip[0] - base[0], tip[1] - base[1])
        ang = math.degrees(math.atan2(base[1] - tip[1], tip[0] - base[0]))   # 90 = straight up
        if not (0.08 * headH < L < 0.75 * headH):
            issues.append(f'{sid}: {side} length implausible'); continue
        if want_open and not (10 < ang < 170):
            issues.append(f'{sid}: {side} not pointing up'); continue
        ears.append({'tip': _r(tip, 0), 'base': _r(base, 0), 'halfw': int(np.clip(0.4 * L, 18, 130))})
    if len(ears) == 2:
        if ears[0]['tip'][0] > ears[1]['tip'][0]:
            ears.reverse()
        S['ears'] = ears
    body = _poly(c.get('body_outline'), W, H)
    if len(body) >= 4 and _area(body) > 0.15 * _area(head):
        body = [[x, min(y, contact_y(x) + 5)] for x, y in body]
        bx = float(np.mean([p[0] for p in body]))
        S['breath'] = {'poly': _r(body, 0), 'pivot': _r([bx, contact_y(bx)], 0), 'soft': 30}
    else:
        notes.append(f'{sid}: no breath (body outline missing)')
    tl = _poly(c.get('tail_centerline'), W, H)
    if c.get('tail_visible') and len(tl) >= 3:
        r0 = max(6.0, c.get('tail_width', 0) / 1000.0 * W / 2)
        L = sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(tl[:-1], tl[1:]))
        bad = [p for p in tl[1:] if _inside(face, p, -0.5 * r0)]
        if _loops(tl):
            notes.append(f'{sid}: tail centreline folds back on itself -> no tail motion')
            tl = []
        elif sum(1 for p in tl[1:] if p[1] > contact_y(p[0]) - 1.2 * r0) > len(tl[1:]) // 3:
            # a tail lying on the blanket/table crosses the anchored contact line: bending it would tear the ledge edge
            notes.append(f'{sid}: tail lies on the ledge -> no tail motion')
            tl = []
        if not tl:
            pass
        elif not (8 <= r0 <= 90):
            issues.append(f'{sid}: tail width implausible ({r0:.0f}px)')
        elif L < 3 * r0:
            issues.append(f'{sid}: tail too short')
        elif bad:
            issues.append(f'{sid}: tail centreline runs over the face')
        else:
            # base = the end nearer the ledge / body
            if tl[0][1] < tl[-1][1] and abs(tl[0][1] - tl[-1][1]) > 2 * r0 and contact_y(tl[-1][0]) - tl[-1][1] < contact_y(tl[0][0]) - tl[0][1]:
                tl = tl[::-1]
            S['tail'] = {'points': _r(tl, 0), 'radius': [_r(r0 * 1.1, 0), _r(r0 * 0.9, 0)], 'in': 6,
                         'out': int(np.clip(r0, 18, 45)), 'baseFade': 0.12}
    else:
        notes.append(f'{sid}: no tail')
    pins = []
    for b in c.get('paws') or []:
        x0, y0 = _P({'x': b['x0'], 'y': b['y0']}, W, H); x1, y1 = _P({'x': b['x1'], 'y': b['y1']}, W, H)
        box = [[x0 - 8, y0 - 8], [x1 + 8, y0 - 8], [x1 + 8, y1 + 8], [x0 - 8, y1 + 8]]
        near_face = any(_inside(face, p, -(S['faceSoft'] + 20)) for p in box + [[(x0 + x1) / 2, y0], [(x0 + x1) / 2, (y0 + y1) / 2]])
        if near_face:
            notes.append(f'{sid}: paw pin dropped (touches the face)')
        else:
            pins.append({'poly': _r(box, 0), 'band': 18})
    return S, pins, head


def person_subject(p, W, H, gray, contact_y, issues, notes, sid='girl'):
    face0 = _poly(p['face_outline'], W, H)
    if len(face0) < 8:
        issues.append('person: face outline missing'); return None
    fx0, fy0 = np.min(face0, 0); fx1, fy1 = np.max(face0, 0)
    fW, fH = fx1 - fx0, fy1 - fy0
    chin = _P(p['chin'], W, H)
    S = {'id': sid, 'kind': 'person', 'eyes': []}
    for side in ('left_eye', 'right_eye'):
        b = p[side]
        x0, y0 = _P({'x': b['x0'], 'y': b['y0']}, W, H); x1, y1 = _P({'x': b['x1'], 'y': b['y1']}, W, H)
        cc, rr = ((x0 + x1) / 2, (y0 + y1) / 2), (abs(x1 - x0) / 2 * 0.9, abs(y1 - y0) / 2 * 0.9)
        if not _inside(face0, cc, 2):
            issues.append(f'person: {side} outside the face')
        if rr[0] < 6 or rr[0] > 0.25 * fW:
            issues.append(f'person: {side} size implausible')
        S['eyes'].append({'c': _r(list(cc)), 'r': _r(list(rr)), 'rot': 0, 'pupil': [0, 0], 'fall': [0.55, 0.98]})
    face = _scale_poly(face0, 1.12)
    S['face'] = _r([[min(W - 1, max(0, x)), min(y, contact_y(x) - 14)] for x, y in face], 0)
    S['faceSoft'] = int(np.clip(0.15 * fW, 25, 50))
    S['neck'] = _r([chin[0], chin[1] + 0.12 * fH], 0)
    body = _poly(p.get('body_outline'), W, H)
    sh, ar = p['shoulder_y'] / 1000 * (H - 1), p['arms_y'] / 1000 * (H - 1)
    if len(body) >= 4 and ar > sh + 40:
        S['breath'] = {'poly': _r([[x, min(y, contact_y(x) + 5)] for x, y in body], 0), 'y0': _r(ar, 0), 'y1': _r(sh, 0), 'soft': 30}
    hair = []
    for k in ('hair_left', 'hair_right'):
        hp = _poly(p.get(k), W, H)
        if len(hp) >= 4 and _area(hp) > 0.05 * fW * fH:
            y0, y1 = min(q[1] for q in hp), max(q[1] for q in hp)
            root = max(y0 + 0.25 * (y1 - y0), S['eyes'][0]['c'][1] if S['eyes'] else y0)
            hair.append({'poly': _r(hp, 0), 'root': _r(root, 0), 'tip': _r(y1 - 0.08 * (y1 - y0), 0)})
    if hair:
        S['hair'] = hair
    return S, [], face0


def build(lm, img, recipe):
    H, W = img.shape[:2]
    gray = cv2.GaussianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.0)
    issues, notes = [], []
    if not lm.get('usable', False):
        issues.append('vision check: ' + '; '.join(lm.get('problems') or ['not usable']))
    led = [_P(q, W, H) for q in lm.get('ledge') or []]
    if len(led) < 3:
        issues.append('no ledge line'); return None, issues, notes
    pts, nt = refine_ledge(gray, led, W, H)
    notes.append(nt)
    ys = [p[1] for p in pts]
    lo, hi = recipe.get('ledge_range', (0.6, 0.84))
    if min(ys) < (lo - 0.07) * H or max(ys) > (hi + 0.04) * H:
        issues.append(f'ledge outside {lo - 0.07:.2f}-{hi + 0.04:.2f} of the height ({min(ys) / H:.2f}-{max(ys) / H:.2f})')
    if max(ys) - min(ys) > 0.14 * H:
        issues.append('ledge not roughly horizontal')
    px, py = np.array([p[0] for p in pts]), np.array(ys)
    contact_y = lambda x: float(np.interp(x, px, py))

    want = recipe['subjects']                      # e.g. ['cat'] or ['person', 'cat']
    want_open = recipe.get('pose') != 'sleep'
    ncat, nper = want.count('cat'), want.count('person')
    if len(lm.get('cats') or []) != ncat:
        issues.append(f'expected {ncat} cat(s), got {len(lm.get("cats") or [])}')
    if len(lm.get('people') or []) != nper:
        issues.append(f'expected {nper} person(s), got {len(lm.get("people") or [])}')
    if issues:
        return None, issues, notes
    subjects, pins, heads = [], [], []
    for p in lm['people']:
        r = person_subject(p, W, H, gray, contact_y, issues, notes)
        if r:
            subjects.append(r[0]); heads.append(r[2])
    for i, c in enumerate(lm['cats']):
        r = cat_subject(c, W, H, gray, contact_y, want_open, issues, notes, sid='cat' if i == 0 else f'cat{i + 1}')
        if r:
            subjects.append(r[0]); pins += r[1]; heads.append(r[2])
    # composition: heads must not sit in the clock area or be cut by the border
    for hd in heads:
        x0, y0 = np.min(hd, 0); x1, y1 = np.max(hd, 0)
        if y0 < 4 or x0 < 4 or x1 > W - 5:
            issues.append('a head touches the picture border')
        cx = (x0 + x1) / 2
        if cx < 0.2 * W and y0 < 0.33 * H:
            issues.append('a head sits in the clock area')
        if recipe.get('pose') == 'cat' and not (0.36 * W <= cx <= 0.62 * W and x1 <= 0.80 * W):
            issues.append(f'head not near the centre (x {cx / W:.2f}, right edge {x1 / W:.2f}): would sit behind the right panel')
    if len(subjects) >= 2:
        f0 = np.array(subjects[0]['face']); f1 = np.array(subjects[1]['face'])
        m0 = np.zeros((H, W), np.uint8); m1 = m0.copy()
        cv2.fillPoly(m0, [f0.astype(np.int32)], 1); cv2.fillPoly(m1, [f1.astype(np.int32)], 1)
        if (m0 & m1).sum() > 0:
            issues.append('faces overlap')
    tails = [s for s in subjects if s.get('tail')]
    for s in tails[1:]:
        del s['tail']                                  # one tail per scene (engine2)
    rig = {
        'version': 2, 'src': 'SRC', 'grid': 8, 'jpegQ': 90, 'grade': recipe.get('grade', 0.3),
        'swat': False,
        'contact': {'points': pts, 'band': 10},
        'pins': pins,
        'hl': {'hlMin': 150, 'hlTop': 40, 'hlSat': 80, 'hlArea': 3},
        'subjects': subjects,
    }
    return rig, issues, notes
