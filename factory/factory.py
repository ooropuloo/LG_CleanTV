#!/usr/bin/env python3
"""tv-home scene factory: one run = try to produce ONE new living-image scene (v2 pack) and publish it.

    python factory.py run [--trigger scheduled|manual|test] [--recipe subject:style:theme:tod] [--no-publish]
    python factory.py status

Runs inside the `tvhome-factory` container (see run.sh). Paths (container):
  /factory            this code (read-only), refs/ = reference pictures
  /tvhome/cats        tv-home cats (read-only), /tvhome/cats/gen-live (read-write) = published packs + scenes.json
  /data/state         status.json, history.json, lock      (bridge reads these)
  /data/work/<run>    per-run work + debug images (old runs pruned)
Steps: recipe -> agy image (+refs) -> normalise 1672x941 -> agy check+landmarks -> rig (refine+validate) ->
prep_scene.py -> offline max-deformation check -> agy review of the debug overlays -> atomic publish.
"""
import argparse
import datetime as dt
import fcntl
import glob
import json
import os
import random
import shutil
import subprocess
import sys
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cv2  # noqa: E402
import numpy as np  # noqa: E402
import agyx  # noqa: E402
import imgutil  # noqa: E402
import landmarks as LM  # noqa: E402
import rigbuild  # noqa: E402
import warpqa  # noqa: E402

DATA = os.environ.get('FACTORY_DATA', '/data')
CATS = os.environ.get('TVHOME_CATS', '/tvhome/cats')
GEN = os.path.join(CATS, 'gen-live')
STATE = os.path.join(DATA, 'state')
WORK = os.path.join(DATA, 'work')
PREP = os.path.join(CATS, 'live', 'tools', 'prep_scene.py')
REFS = os.path.join(HERE, 'refs')
R = json.load(open(os.path.join(HERE, 'recipes.json'), encoding='utf-8'))
LOGF = None


def now():
    return dt.datetime.now().astimezone()


def log(msg):
    line = f'{now().strftime("%H:%M:%S")} {msg}'
    print(line, flush=True)
    if LOGF:
        with open(LOGF, 'a', encoding='utf-8') as f:
            f.write(line + '\n')


def jload(p, default):
    try:
        with open(p, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def jsave(p, obj):
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, p)


def set_status(**kw):
    st = jload(os.path.join(STATE, 'status.json'), {})
    st.update(kw)
    st['updated'] = now().isoformat(timespec='seconds')
    jsave(os.path.join(STATE, 'status.json'), st)


# ------------------------------------------------------------------ recipe
def pick_recipe(history, forced=None, rnd=None):
    rnd = rnd or random.Random()
    month = now().month
    recent = [h.get('recipe', {}).get('key') for h in history[-R['avoid_recent']:]]
    recent_themes = [h.get('recipe', {}).get('theme') for h in history[-3:]]
    if forced:
        sub, sty, th, tod = forced.split(':')
        return make_recipe(sub, sty, th, tod, rnd)
    cands = []
    for sub, S in R['subjects'].items():
        for sty in S.get('styles') or list(R['styles']):
            for T in R['themes']:
                if T.get('only') and sub not in T['only']:
                    continue
                if T.get('months') and month not in T['months']:
                    continue
                if T.get('pose') == 'sleep' and 'person' in S['kinds']:
                    continue
                for tod in T['tods']:
                    key = f'{sub}:{sty}:{T["id"]}:{tod}'
                    if key in recent:
                        continue
                    w = S['weight'] * R['styles'][sty]['weight'] * (0.3 if T['id'] in recent_themes else 1.0)
                    w *= 1.6 if T.get('months') else 1.0                     # seasonal themes when in season
                    cands.append((w, sub, sty, T['id'], tod))
    tot = sum(c[0] for c in cands)
    x = rnd.random() * tot
    for c in cands:
        x -= c[0]
        if x <= 0:
            return make_recipe(*c[1:], rnd)
    return make_recipe(*cands[-1][1:], rnd)


def make_recipe(sub, sty, th, tod, rnd):
    S, T = R['subjects'][sub], [t for t in R['themes'] if t['id'] == th][0]
    pose = T.get('pose') or ('person' if 'person' in S['kinds'] else 'cat')
    ledge = rnd.choice(R['ledges'])
    lay = R['layout']['sleep' if pose == 'sleep' else ('person' if pose == 'person' else 'cat')]
    prompt = lay.format(style=R['styles'][sty]['text'], coat=S['coat'], ledge=ledge, tod=R['tods'][tod]['text'], theme=T['text']) + R['layout']['tail']
    refs = [(os.path.join(REFS, f), role) for f, role in S['refs'][sty]]
    name = f'{S["zh"]}・{T["zh"] if pose != "sleep" else ""}{R["tods"][tod]["zh"]}' if pose != 'sleep' else f'{S["zh"]}・{R["tods"][tod]["zh"]}睡覺'
    return {'key': f'{sub}:{sty}:{th}:{tod}', 'subject': sub, 'style': sty, 'theme': th, 'tod': tod, 'pose': pose,
            'subjects': S['kinds'], 'coat': S['coat'], 'ledge': ledge, 'prompt': prompt, 'refs': refs,
            'name': name + ('' if sty == 'film3d' else '(寫實)'), 'grade': R['grade'][tod],
            'motion': R['motion']['sleep' if pose == 'sleep' else ('person' if pose == 'person' else 'cat')],
            'ledge_range': R['ledge_range']['sleep' if pose == 'sleep' else ('person' if pose == 'person' else 'cat')]}


# ------------------------------------------------------------------ QA review (agy)
REVIEW_SCHEMA = {
    'type': 'object',
    'properties': {
        'pass': {'type': 'boolean'},
        'score': {'type': 'integer', 'description': '1-10 overall quality as a calm, beautiful animated TV wallpaper'},
        'problems': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': ['pass', 'score', 'problems'],
}
REVIEW_PROMPT = """You review an automatically rigged animated wallpaper before it is shown on a living-room TV. Be strict.
Image 1: the picture with the rig overlay (coloured tints = parts that move; green ellipses = eyes; white outline = rigid face region;
magenta line + dots = tail chain; yellow line = ledge: everything below it never moves. For a blanket/ledge it runs along its top edge;
for a table it runs along the FAR edge of the tabletop where the arms / the cat rest, so the table surface in front of it is below the line — that is correct).
Image 2: the two most extreme animation poses side by side (left = pose A, right = pose B).
Image 3: face close-ups: pose A | rest | pose B for each subject.
Fail (pass=false) if ANY of these: an eye ellipse is not on an eye (or misses most of the eye); the white face region misses part of the face
(e.g. an eye, the nose or the mouth outside it); the tail chain is not on the tail or a tail-coloured region would move without being the tail;
a face looks warped, stretched, melted or doubled in pose A or B (it may shift or tilt slightly as a whole — that is fine);
the ledge line is not along the top of the ledge/blanket/table; furniture or background objects bend visibly; obvious AI defects in the picture
(extra limbs, merged paws, broken anatomy, garbled text, distorted hands); the picture is unpleasant, cluttered or not a good calm wallpaper.
The tints are soft halos by design: a tint reaching some distance past the part it belongs to (background around the tail or ears)
is normal and moves only a little. Fail for a tint only if its CENTRE lies on something else (e.g. the tail chain runs over furniture,
another animal or a person). Small, smooth stretching of plain background near the tail or ears is acceptable."""


def review(dbg, work):
    rig_png = sorted(glob.glob(os.path.join(dbg, '*_rig.png')))[-1]
    a = os.path.join(work, 'rv1.jpg'); imgutil.small(rig_png, a, 1280)
    b = os.path.join(work, 'qa_AB.jpg')
    c = os.path.join(work, 'qa_faces.jpg')
    r, sec = agyx.ask(REVIEW_PROMPT, [(a, 'rig overlay'), (b, 'extreme poses A | B'), (c, 'face close-ups A | rest | B')],
                      REVIEW_SCHEMA, log=log, model=os.environ.get('AGY_REVIEW_MODEL', 'gemini-3.8-flash-medium'))
    return r, sec


# ------------------------------------------------------------------ one attempt
def attempt(recipe, work, k):
    os.makedirs(work, exist_ok=True)
    rec = {'attempt': k, 'ok': False, 'times': {}}
    t0 = time.time()
    raw = os.path.join(work, 'raw.img')
    set_status(step=f'attempt {k}: generating image')
    log(f'[{k}] generate: {recipe["key"]} ledge="{recipe["ledge"]}"')
    try:
        if os.environ.get('FACTORY_FROM_IMAGE'):          # testing: skip generation
            shutil.copy(os.environ['FACTORY_FROM_IMAGE'], raw); sec = 0
        else:
            _, sec = agyx.generate(recipe['prompt'], recipe['refs'], raw, log=log, timeout=int(os.environ.get('AGY_GEN_TIMEOUT', '300')))
    except agyx.AgyQuota as e:
        rec['reason'] = f'generate: {e}'; rec['quota'] = e.reset or True; return rec
    except agyx.AgyError as e:
        rec['reason'] = f'generate: {e}'; return rec
    rec['times']['generate'] = round(sec)
    src = os.path.join(work, 'source.png')
    try:
        w0, h0 = imgutil.normalise(raw, src)
    except ValueError as e:
        rec['reason'] = f'image: {e}'; return rec
    rec['gen_size'] = [w0, h0]
    img = cv2.imread(src)
    zones = imgutil.ui_zones(img)
    rec['zones'] = zones
    log(f'[{k}] image {w0}x{h0} zones {zones}')
    if zones['clock']['lum'] > 0.42 or zones['clock']['detail'] > 2.0:          # white clock text must stay readable (hand-made scenes: lum <= 0.31)
        rec['reason'] = f'clock area too bright/busy {zones["clock"]}'; return rec
    # ---- check + landmarks
    set_status(step=f'attempt {k}: landmarks')
    a, g = os.path.join(work, 'lm_a.jpg'), os.path.join(work, 'lm_g.jpg')
    imgutil.small(src, a); imgutil.grid(src, g)
    expect = {'cat': f'one {recipe["coat"]} peeking over a ledge, eyes open',
              'sleep': f'one {recipe["coat"]} asleep on a blanket, eyes closed',
              'person': f'one young woman behind a table and one {recipe["coat"]} lying on the table next to her'}[recipe['pose']]
    extra = 'the cat\'s eyes are open (it must be asleep with closed eyes); ' if recipe['pose'] == 'sleep' else 'the tail is hidden or merged with the body; '
    prompt = LM.PROMPT.format(expect=expect, coat=recipe['coat'].split(' with ')[0], extra=extra)
    lm = None
    for model in (os.environ.get('AGY_LM_MODEL', 'gemini-3.8-flash-medium'), 'gemini-3.8-flash-low'):
        try:
            lm, sec = agyx.ask(prompt, [(a, 'candidate picture'), (g, 'same picture with the 0..1000 grid')], LM.SCHEMA, log=log, model=model)
            rec['times']['landmarks'] = round(sec)
            break
        except (agyx.AgyError, ValueError) as e:
            log(f'[{k}] landmarks with {model} failed: {e}')
    if lm is None:
        rec['reason'] = 'landmarks: agy failed'; return rec
    json.dump(lm, open(os.path.join(work, 'landmarks.json'), 'w'), indent=1)
    rig, issues, notes = rigbuild.build(lm, img, recipe)
    for n in notes:
        log(f'[{k}] note: {n}')
    if rig:
        ys = [p[1] / img.shape[0] for p in rig['contact']['points']]
        lo, hi = recipe['ledge_range']
        if not (lo <= float(np.median(ys)) <= hi):
            issues.append(f'ledge at {np.median(ys):.2f} of the height, expected {lo}-{hi}')
    if issues:
        rec['reason'] = 'rig: ' + '; '.join(issues); return rec
    # ---- prep
    set_status(step=f'attempt {k}: prep')
    pack = os.path.join(work, 'pack')
    os.makedirs(pack, exist_ok=True)
    shutil.copy(src, os.path.join(pack, 'source.png'))
    rig['src'] = os.path.join(pack, 'source.png')
    json.dump(rig, open(os.path.join(pack, 'rig.json'), 'w'), indent=1)
    dbg = os.path.join(work, 'dbg'); os.makedirs(dbg, exist_ok=True)
    t1 = time.time()
    p = subprocess.run([sys.executable, PREP, pack], capture_output=True, text=True, env=dict(os.environ, LIVE_DBG=dbg), timeout=900)
    rec['times']['prep'] = round(time.time() - t1)
    if p.returncode != 0:
        rec['reason'] = 'prep failed: ' + p.stderr[-300:]; return rec
    log(f'[{k}] prep {rec["times"]["prep"]}s: {p.stdout.strip()[-200:]}')
    return qa_and_review(recipe, work, img, rig, pack, dbg, rec, k, t0)


def qa_and_review(recipe, work, img, rig, pack, dbg, rec, k, t0):
    # ---- offline max-deformation check
    set_status(step=f'attempt {k}: QA')
    motion = recipe['motion']
    res = warpqa.check(img, rig, os.path.join(pack, 'assets'), motion, os.path.join(work, 'qa'))
    bad = warpqa.verdict(res)
    rec['warp'] = res['frames']
    log(f'[{k}] warp check {json.dumps(res["frames"])} -> {bad or "ok"}')
    if bad:
        rec['reason'] = 'warp: ' + '; '.join(bad); return rec
    # ---- vision review of the overlays
    try:
        rv, sec = review(dbg, work)
        rec['times']['review'] = round(sec)
    except (agyx.AgyError, ValueError) as e:
        rec['reason'] = f'review: agy failed {e}'; return rec
    rec['review'] = rv
    log(f'[{k}] review {json.dumps(rv, ensure_ascii=False)}')
    if not rv.get('pass') or rv.get('score', 0) < 6:
        rec['reason'] = 'review: ' + '; '.join(rv.get('problems') or ['failed']); return rec
    json.dump(motion, open(os.path.join(pack, 'motion.json'), 'w'), indent=1)
    rec['ok'] = True
    rec['times']['total'] = round(time.time() - t0)
    return rec


# ------------------------------------------------------------------ publish
def thumb(src, out):
    im = cv2.imread(src)
    cv2.imwrite(out, cv2.resize(im, (320, 180), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 82])


def publish(recipe, pack, run_id):
    os.makedirs(GEN, exist_ok=True)
    pid = run_id
    replaced = None
    if os.path.exists(os.path.join(GEN, pid)) or any(s.get('coat', '').startswith(run_id) for s in jload(os.path.join(GEN, 'scenes.json'), {}).get('scenes', [])):
        # re-publish (recheck): new id, because the TV caches image.jpg / mesh.bin for an hour per URL
        replaced = [s['coat'] for s in jload(os.path.join(GEN, 'scenes.json'), {}).get('scenes', []) if s.get('coat', '').startswith(run_id)]
        pid = f'{run_id}-{now().strftime("%H%M%S")}'
    tmp = os.path.join(GEN, f'.tmp-{pid}')
    shutil.rmtree(tmp, ignore_errors=True)
    os.makedirs(os.path.join(tmp, 'assets'))
    for f in ('image.jpg', 'eyes.png', 'mesh.bin', 'pack.json', 'aux.png'):
        s = os.path.join(pack, 'assets', f)
        if os.path.exists(s):
            shutil.copy(s, os.path.join(tmp, 'assets', f))
    thumb(os.path.join(pack, 'source.png'), os.path.join(tmp, 'assets', 'thumb.jpg'))
    cv2.imwrite(os.path.join(tmp, 'source.jpg'), cv2.imread(os.path.join(pack, 'source.png')), [cv2.IMWRITE_JPEG_QUALITY, 94])
    rig = json.load(open(os.path.join(pack, 'rig.json')))
    rig['src'] = 'cats/gen-live/%s/source.jpg' % pid
    json.dump(rig, open(os.path.join(tmp, 'rig.json'), 'w'), indent=1)
    shutil.copy(os.path.join(pack, 'motion.json'), os.path.join(tmp, 'motion.json'))
    created = now().isoformat(timespec='seconds')
    meta = {k: recipe[k] for k in ('key', 'subject', 'style', 'theme', 'tod', 'pose', 'name', 'ledge')}
    meta.update(created=created, id=pid)
    json.dump(meta, open(os.path.join(tmp, 'meta.json'), 'w'), ensure_ascii=False, indent=1)
    dst = os.path.join(GEN, pid)
    os.rename(tmp, dst)                        # atomic: the pack appears complete or not at all
    scenes = jload(os.path.join(GEN, 'scenes.json'), {'scenes': []})
    first = min([s.get('created', created) for s in scenes.get('scenes', []) if s.get('coat') in (replaced or [])] or [created])
    lst = [s for s in scenes.get('scenes', []) if s.get('coat') != pid and s.get('coat') not in (replaced or [])]
    lst.append({'id': f'gen-{pid}', 'name': recipe['name'], 'style': 'gen-live', 'coat': pid, 'gen': True,
                'tod': recipe['tod'], 'pose': recipe['pose'], 'created': first, 'recipe': recipe['key']})
    # prune: keep the newest max_scenes (entries marked keep:true are never pruned)
    pruned = list(replaced or [])
    jsave(os.path.join(GEN, 'scenes.json'), {'updated': created, 'scenes': lst})
    for v in pruned:                            # only after scenes.json no longer lists them
        d = os.path.join(GEN, v)
        if os.path.isdir(d) and os.path.basename(d) == v and v.startswith('g'):
            shutil.rmtree(d, ignore_errors=True)
    before = {s['coat'] for s in lst}
    prune_gen()                                 # count + size budget
    pruned += sorted(before - {s['coat'] for s in jload(os.path.join(GEN, 'scenes.json'), {}).get('scenes', [])})
    return pid, pruned


def cleanup_gen():
    """Remove leftovers of interrupted publishes and pack folders not listed in scenes.json."""
    if not os.path.isdir(GEN):
        return
    listed = {s['coat'] for s in jload(os.path.join(GEN, 'scenes.json'), {'scenes': []}).get('scenes', [])}
    for d in os.listdir(GEN):
        p = os.path.join(GEN, d)
        if (d.startswith('.tmp-') or d.startswith('.old-')) and time.time() - os.path.getmtime(p) > 600:
            shutil.rmtree(p, ignore_errors=True)
        elif os.path.isdir(p) and d.startswith('g') and d not in listed and time.time() - os.path.getmtime(p) > 600:
            shutil.rmtree(p, ignore_errors=True)


# ------------------------------------------------------------------ disk budget (host root fs is 29 GB, shared with HA)
MIN_FREE_GB = float(os.environ.get('FACTORY_MIN_FREE_GB', '4'))
GEN_MAX_MB = float(os.environ.get('FACTORY_GEN_MAX_MB', '300'))
REJECTS = os.path.join(STATE, 'rejects')          # tiny thumbnails of rejected images (JSON is in history.json), last 50


def du(path):
    n = 0
    for root, _, files in os.walk(path):
        for f in files:
            try:
                n += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return n


def disk_info():
    u = shutil.disk_usage(DATA)
    scenes = jload(os.path.join(GEN, 'scenes.json'), {}).get('scenes', [])
    return {'free_gb': round(u.free / 1e9, 2), 'total_gb': round(u.total / 1e9, 1), 'gen_mb': round(du(GEN) / 1e6, 1),
            'gen_count': len(scenes), 'work_mb': round(du(WORK) / 1e6, 1), 'at': now().isoformat(timespec='seconds')}


def prune_work(keep_run=None):
    """Delete per-run work folders (raw downloads, packs, debug images) except keep_run; FACTORY_KEEP_WORK=1 keeps the newest."""
    freed = 0
    runs = sorted(d for d in os.listdir(WORK) if d.startswith('r'))
    keep = {keep_run} if keep_run else set()
    if os.environ.get('FACTORY_KEEP_WORK') == '1' and runs:
        keep.add(runs[-1])
    for d in runs:
        if d not in keep:
            freed += du(os.path.join(WORK, d))
            shutil.rmtree(os.path.join(WORK, d), ignore_errors=True)
    freed += du(os.path.join(WORK, 'agy'))
    shutil.rmtree(os.path.join(WORK, 'agy'), ignore_errors=True)
    os.makedirs(os.path.join(WORK, 'agy'), exist_ok=True)
    return freed


def archive_rejects(work, run_id, attempts):
    os.makedirs(REJECTS, exist_ok=True)
    for a in attempts:
        if a.get('ok'):
            continue
        src = os.path.join(work, 'a%s' % a['attempt'], 'source.png')
        im = cv2.imread(src) if os.path.exists(src) else None
        if im is not None:
            cv2.imwrite(os.path.join(REJECTS, '%s_a%s.jpg' % (run_id, a['attempt'])),
                        cv2.resize(im, (320, 180), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 75])
    fs = sorted(os.listdir(REJECTS))
    for f in fs[:-50]:
        os.remove(os.path.join(REJECTS, f))


def prune_gen():
    """Keep cats/gen-live within max_scenes AND GEN_MAX_MB: drop oldest first (never `keep: true`, never hand-made packs)."""
    path = os.path.join(GEN, 'scenes.json')
    d = jload(path, None)
    if not d:
        return 0
    lst = d.get('scenes', [])
    size = {s['coat']: du(os.path.join(GEN, s['coat'])) for s in lst}
    total = sum(size.values())
    victims = []
    while lst and (len(lst) > R['max_scenes'] or total > GEN_MAX_MB * 1e6):
        old = [s for s in lst if not s.get('keep')]
        if not old:
            break
        v = min(old, key=lambda s: s.get('created', ''))
        lst.remove(v)
        victims.append(v['coat'])
        total -= size.get(v['coat'], 0)
    if not victims:
        return 0
    d['scenes'] = lst
    jsave(path, d)
    freed = 0
    for v in victims:                      # only after scenes.json no longer lists them
        p_ = os.path.join(GEN, v)
        if os.path.isdir(p_) and v.startswith('g'):
            freed += du(p_)
            shutil.rmtree(p_, ignore_errors=True)
    log('pruned generated scenes %s' % victims)
    return freed


def cleanup(keep_run=None):
    """Disk housekeeping; returns bytes freed (work folders, gen-live over budget, leftovers)."""
    freed = prune_work(keep_run)              # (agy's own brain/ folders: host script /opt/agy-cleanup.sh)
    cleanup_gen()
    freed += prune_gen()
    return freed


# ------------------------------------------------------------------ main
def run(args):
    global LOGF
    for d in (STATE, WORK, os.path.join(WORK, 'agy')):
        os.makedirs(d, exist_ok=True)
    lockf = open(os.path.join(STATE, 'lock'), 'w')
    try:
        fcntl.flock(lockf, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('another run is in progress'); return 3
    cleanup()
    di = disk_info()
    if di['free_gb'] < MIN_FREE_GB:
        print('disk low: %s GB free < %s GB: skip' % (di['free_gb'], MIN_FREE_GB))
        set_status(state='idle', step='', result='disk low', disk=di)
        return 5
    qr = jload(os.path.join(STATE, 'status.json'), {}).get('quota_reset')
    if qr and not args.recipe:
        try:
            if dt.datetime.fromisoformat(qr.replace('Z', '+00:00')) > now():
                print(f'image quota still exhausted until {qr}: skip'); set_status(state='idle', step='', result='quota')
                return 4
        except ValueError:
            pass
    run_id = 'g' + now().strftime('%Y%m%d-%H%M%S')
    work = os.path.join(WORK, 'r' + run_id[1:])
    os.makedirs(work, exist_ok=True)
    LOGF = os.path.join(work, 'log.txt')
    hist = jload(os.path.join(STATE, 'history.json'), [])
    recipe = pick_recipe(hist, args.recipe)
    json.dump({k: v for k, v in recipe.items() if k != 'refs'}, open(os.path.join(work, 'recipe.json'), 'w'), ensure_ascii=False, indent=1)
    t0 = time.time()
    entry = {'run': run_id, 'trigger': args.trigger, 'started': now().isoformat(timespec='seconds'),
             'recipe': {k: recipe[k] for k in ('key', 'subject', 'style', 'theme', 'tod', 'pose', 'name')}, 'attempts': []}
    set_status(state='running', run=run_id, trigger=args.trigger, started=entry['started'], step='start', recipe=recipe['name'])
    log(f'run {run_id} trigger={args.trigger} recipe={recipe["key"]}')
    result = 'rejected'
    try:
        n = int(os.environ.get('FACTORY_ATTEMPTS', R['attempts']))
        for k in range(1, n + 1):
            rec = attempt(recipe, os.path.join(work, f'a{k}'), k)
            entry['attempts'].append({x: rec.get(x) for x in ('attempt', 'ok', 'reason', 'times', 'review', 'gen_size')})
            if rec['ok']:
                if args.no_publish:
                    result = 'ok (not published)'
                else:
                    set_status(step='publishing')
                    pid, pruned = publish(recipe, os.path.join(work, f'a{k}', 'pack'), run_id)
                    entry.update(published=pid, scene=f'gen-{pid}', name=recipe['name'], pruned=pruned)
                    result = 'published'
                    log(f'published cats/gen-live/{pid} ({recipe["name"]}) pruned={pruned}')
                break
            log(f'[{k}] REJECTED: {rec.get("reason")}')
            if rec.get('quota'):
                result = 'quota'
                entry['quota_reset'] = rec['quota'] if isinstance(rec['quota'], str) else ''
                log('image quota exhausted: stop (no more attempts this run)')
                break
    except Exception as e:  # noqa: BLE001
        result = 'error'
        entry['error'] = f'{type(e).__name__}: {e}'
        log(traceback.format_exc())
    entry.update(result=result, seconds=round(time.time() - t0), finished=now().isoformat(timespec='seconds'))
    try:
        archive_rejects(work, run_id, entry['attempts'])
        freed = cleanup()                       # this run's work folder too (published packs live in cats/gen-live)
        log('cleanup freed %.1f MB' % (freed / 1e6))
    except Exception as e:  # noqa: BLE001
        log('cleanup failed: %s' % e)
    entry['disk'] = disk_info()
    hist.append(entry)
    jsave(os.path.join(STATE, 'history.json'), hist[-200:])
    last_ok = next((h for h in reversed(hist) if h.get('result') == 'published'), None)
    set_status(state='idle', step='', result=result, last_run=entry['run'], disk=entry['disk'], quota_reset=entry.get('quota_reset') if result == 'quota' else None, last_finished=entry['finished'],
               last_seconds=entry['seconds'], last_reason=(entry['attempts'][-1].get('reason') if entry['attempts'] and result != 'published' else entry.get('error')),
               latest=({'scene': last_ok['scene'], 'name': last_ok['name'], 'at': last_ok['finished']} if last_ok else None))
    log(f'run {run_id} -> {result} in {entry["seconds"]}s')
    return 0 if result in ('published', 'ok (not published)') else 1


def recheck(adir, do_publish, rerig=False):
    """Re-run the QA + review of an existing attempt folder (e.g. after a reviewer prompt fix) and publish if it passes."""
    global LOGF
    run_dir = os.path.dirname(adir.rstrip('/'))
    rj = jload(os.path.join(run_dir, 'recipe.json'), None)
    if rj is None:
        print('no recipe.json in', run_dir); return 2
    recipe = make_recipe(rj['subject'], rj['style'], rj['theme'], rj['tod'], random.Random(0))
    LOGF = os.path.join(adir, 'recheck.txt')
    pack = os.path.join(adir, 'pack')
    img = cv2.imread(os.path.join(adir, 'source.png'))
    if rerig:                                      # rebuild the rig from the saved landmarks with the current rules + prep again
        lm = json.load(open(os.path.join(adir, 'landmarks.json')))
        rig, issues, notes = rigbuild.build(lm, img, recipe)
        for n in notes:
            log(f'[R] note: {n}')
        if issues:
            log(f'recheck -> rig rejected: {issues}'); return 1
        rig['src'] = os.path.join(pack, 'source.png')
        json.dump(rig, open(os.path.join(pack, 'rig.json'), 'w'), indent=1)
        dbg = os.path.join(adir, 'dbg'); os.makedirs(dbg, exist_ok=True)
        p = subprocess.run([sys.executable, PREP, pack], capture_output=True, text=True, env=dict(os.environ, LIVE_DBG=dbg), timeout=900)
        if p.returncode != 0:
            log('recheck -> prep failed ' + p.stderr[-300:]); return 1
    rig = json.load(open(os.path.join(pack, 'rig.json')))
    rec = {'attempt': 'recheck', 'ok': False, 'times': {}}
    rec = qa_and_review(recipe, adir, img, rig, pack, os.path.join(adir, 'dbg'), rec, 'R', time.time())
    log(f'recheck -> ok={rec["ok"]} {rec.get("reason", "")}')
    set_status(step='')
    if rec['ok'] and do_publish:
        rid = 'g' + os.path.basename(run_dir)[1:]
        pid, pruned = publish(recipe, pack, rid)
        hist = jload(os.path.join(STATE, 'history.json'), [])
        hist.append({'run': rid, 'trigger': 'recheck', 'started': now().isoformat(timespec='seconds'), 'finished': now().isoformat(timespec='seconds'),
                     'recipe': {k: recipe[k] for k in ('key', 'subject', 'style', 'theme', 'tod', 'pose', 'name')}, 'attempts': [rec],
                     'result': 'published', 'published': pid, 'scene': f'gen-{pid}', 'name': recipe['name'], 'seconds': 0})
        jsave(os.path.join(STATE, 'history.json'), hist[-200:])
        st = jload(os.path.join(STATE, 'status.json'), {})
        set_status(latest={'scene': f'gen-{pid}', 'name': recipe['name'], 'at': now().isoformat(timespec='seconds')}, result=st.get('result'))
        log(f'published cats/gen-live/{pid} ({recipe["name"]})')
    return 0 if rec['ok'] else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['run', 'status', 'recipe', 'recheck', 'cleanup'])
    ap.add_argument('dir', nargs='?', help='recheck: attempt folder, e.g. /data/work/r20261115-143217/a1')
    ap.add_argument('--publish', action='store_true', help='recheck: publish when it passes')
    ap.add_argument('--rerig', action='store_true', help='recheck: rebuild the rig from landmarks.json with the current rules first')
    ap.add_argument('--trigger', default='manual')
    ap.add_argument('--recipe', default=None, help='subject:style:theme:tod')
    ap.add_argument('--no-publish', action='store_true')
    a = ap.parse_args()
    if a.cmd == 'status':
        print(json.dumps(jload(os.path.join(STATE, 'status.json'), {}), ensure_ascii=False, indent=1)); return 0
    if a.cmd == 'cleanup':
        for dd in (STATE, WORK):
            os.makedirs(dd, exist_ok=True)
        b = disk_info()
        freed = cleanup()
        di = disk_info()
        set_status(disk=di)
        print(json.dumps({'freed_mb': round(freed / 1e6, 1), 'before': b, 'after': di}))
        return 0
    if a.cmd == 'recheck':
        return recheck(a.dir, a.publish, a.rerig)
    if a.cmd == 'recipe':
        r = pick_recipe(jload(os.path.join(STATE, 'history.json'), []), a.recipe)
        print(json.dumps({k: v for k, v in r.items() if k != 'refs'}, ensure_ascii=False, indent=1)); return 0
    return run(a)


if __name__ == '__main__':
    sys.exit(main())
