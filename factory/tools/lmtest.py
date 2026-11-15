"""Dev: run the landmark call on one image and draw the raw answer.  python tools/lmtest.py <img> <outdir> [model]"""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import cv2
import agyx, imgutil, landmarks as LM

src, out = sys.argv[1], sys.argv[2]
model = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(out, exist_ok=True)
n = os.path.join(out, 'norm.png'); imgutil.normalise(src, n)
imgutil.small(n, os.path.join(out, 'a.jpg')); imgutil.grid(n, os.path.join(out, 'g.jpg'))
p = LM.PROMPT.format(expect='one brown tabby cat peeking over a ledge', coat='brown tabby cat', extra='')
r, dt = agyx.ask(p, [(os.path.join(out, 'a.jpg'), 'candidate picture'), (os.path.join(out, 'g.jpg'), 'same picture with grid')], LM.SCHEMA, log=print, model=model)
print('seconds', round(dt))
json.dump(r, open(os.path.join(out, 'lm.json'), 'w'), indent=1)
im = cv2.imread(n); H, W = im.shape[:2]
P = lambda q: (int(q['x'] * W / 1000), int(q['y'] * H / 1000))
def box(b, c):
    cv2.rectangle(im, P({'x': b['x0'], 'y': b['y0']}), P({'x': b['x1'], 'y': b['y1']}), c, 2)
def poly(ps, c, closed=True):
    if ps:
        import numpy as np
        cv2.polylines(im, [np.array([P(q) for q in ps], np.int32)], closed, c, 2)
poly(r['ledge'], (0, 255, 255), False)
for c in r['cats']:
    box(c['left_eye'], (0, 255, 0)); box(c['right_eye'], (0, 255, 0))
    poly(c['head_outline'], (255, 255, 255)); poly(c['body_outline'], (255, 128, 0))
    poly(c['tail_centerline'], (255, 0, 255), False)
    for e in (c['left_ear'], c['right_ear']):
        cv2.line(im, P(e['base']), P(e['tip']), (255, 255, 0), 3)
    cv2.circle(im, P(c['nose']), 6, (0, 0, 255), -1); cv2.circle(im, P(c['chin']), 6, (0, 128, 255), -1)
    for b in c['paws']:
        box(b, (0, 128, 255))
for pp in r['people']:
    box(pp['left_eye'], (0, 255, 0)); box(pp['right_eye'], (0, 255, 0)); poly(pp['face_outline'], (255, 255, 255))
    poly(pp['hair_left'], (0, 200, 0)); poly(pp['hair_right'], (0, 200, 0)); poly(pp['body_outline'], (255, 128, 0))
cv2.imwrite(os.path.join(out, 'raw_overlay.jpg'), im)
print(json.dumps({k: r[k] for k in ('usable', 'problems')}))
