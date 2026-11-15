#!/bin/sh
# tv-home scene factory launcher (HA host, run as root from root's crontab). See README.md.
#   run.sh scheduled              cron: 03:30 Tue + Fri -> one run
#   run.sh watch                  cron: every 5 min -> one run if the TV asked for one (factory-data/inbox/request-*.json)
#   run.sh manual|test [args...]  by hand; extra args go to factory.py (e.g. --recipe tabby:film3d:snow:night --no-publish)
#   run.sh recheck <attempt dir> [--publish]   re-run QA + review of a kept attempt (e.g. after a prompt fix)
#   run.sh cleanup                disk housekeeping only (also done at the start and end of every run)
#   run.sh build                  (re)build the image (only needed when the Dockerfile changes; code is mounted)
# Disable everything: touch $TVHOME_DIR/factory-data/DISABLED   (or remove the two cron lines)
# Env (all optional): TVHOME_DIR (checkout on the host, default = this script's repo), AGY_BIN_HOST (agy binary),
#   AGY_GEMINI_DIR (agy's ~/.gemini with its login), FACTORY_UID (uid:gid the container runs as), FACTORY_TZ
set -u
TV=${TVHOME_DIR:-$(cd "$(dirname "$0")/.." && pwd)}
AGY_BIN_HOST=${AGY_BIN_HOST:-/home/tvhome/.local/bin/agy}
AGY_GEMINI_DIR=${AGY_GEMINI_DIR:-/home/tvhome/.gemini}
FUID=${FACTORY_UID:-1000:1000}
D=$TV/factory-data
IMG=tvhome-factory
NAME=tvhome-factory
mode=${1:-}
[ $# -gt 0 ] && shift
mkdir -p $D/state $D/inbox $D/work $D/logs $D/home
chown $FUID $D $D/state $D/inbox $D/work $D/logs $D/home $TV/cats/gen-live 2>/dev/null
LOG=$D/logs/factory.log
# one launcher at a time (scheduled + watch both fire at 03:30); taken before a request is consumed
if [ "$mode" != build ]; then exec 9>$D/state/host.lock; flock -n 9 || exit 0; fi
[ -f $LOG ] && [ $(stat -c %s $LOG) -gt 2000000 ] && mv $LOG $LOG.1

case "$mode" in
  build)
    docker build -t $IMG $TV/factory || exit 1
    # disk budget: drop the previous (now dangling) factory image layers + build cache
    docker image prune -f --filter label=tvhome-factory=1
    docker builder prune -f >/dev/null 2>&1
    exit 0 ;;
  cleanup) trigger=cleanup ;;   # work folders, gen-live count/size budget, leftovers
  scheduled) [ -e $D/DISABLED ] && exit 0; trigger=scheduled ;;
  watch)
    [ -e $D/DISABLED ] && exit 0
    req=$(ls $D/inbox/request-*.json 2>/dev/null | head -1)
    [ -z "$req" ] && exit 0
    docker ps -q --filter name=^/$NAME$ | grep -q . && exit 0          # a run is in progress; keep the request
    # host-side rate limit as well (the bridge allows 3/day): at most 4 accepted requests per 24 h
    n=$(find $D/inbox -name 'taken-*' -mmin -1440 | wc -l)
    find $D/inbox -name 'taken-*' -mmin +2880 -delete
    if [ "$n" -ge 4 ]; then echo "$(date '+%F %T') request ignored: rate limit" >> $LOG; rm -f "$req"; exit 0; fi
    mv "$req" "$D/inbox/taken-$(basename "$req")"
    trigger=manual ;;
  manual|test) trigger=$mode ;;
  recheck) trigger=recheck ;;   # run.sh recheck /data/work/r<run>/a<k> [--publish]: QA + review again (maintenance)
  *) echo "usage: run.sh scheduled|watch|manual|test|build [factory.py args]"; exit 2 ;;
esac

docker ps -q --filter name=^/$NAME$ | grep -q . && { echo "$(date '+%F %T') already running" >> $LOG; exit 0; }
echo "$(date '+%F %T') start trigger=$trigger $*" >> $LOG
# low priority, <= 2 cores, 700 MB hard (agy ~250 MB + numpy prep ~300 MB, never at the same time), no Docker socket.
# cats/ read-only except cats/gen-live; agy + its OAuth folder (~/.gemini) mounted; runs as $FUID (non-root).
timeout -s TERM 3000 docker run --rm --name $NAME \
  --cpus=2 --cpu-shares=256 --memory=700m --memory-swap=700m --pids-limit=256 \
  --user $FUID -e HOME=/data/home -e TZ=${FACTORY_TZ:-Asia/Taipei} -e AGY_TMP=/data/work/agy \
  -v /etc/localtime:/etc/localtime:ro \
  -v $AGY_BIN_HOST:/usr/local/bin/agy:ro -v $AGY_GEMINI_DIR:/data/home/.gemini \
  -v $TV/factory:/factory:ro -v $TV/cats:/tvhome/cats:ro -v $TV/cats/gen-live:/tvhome/cats/gen-live \
  -v $D:/data \
  $IMG nice -n 15 python /factory/factory.py $( case $trigger in recheck|cleanup) echo $trigger ;; *) echo "run --trigger $trigger" ;; esac ) "$@" >> $LOG 2>&1
rc=$?
if [ $rc -eq 124 ]; then docker kill $NAME >/dev/null 2>&1; echo "$(date '+%F %T') killed after 50 min" >> $LOG; fi
# interrupted (killed / OOM / reboot): don't leave "running" in the status the TV shows
python3 - "$D/state/status.json" <<'EOF'
import json, sys, os
p = sys.argv[1]
try:
    s = json.load(open(p))
except Exception:
    sys.exit(0)
if s.get('state') == 'running':
    s.update(state='idle', step='', result='interrupted')
    json.dump(s, open(p + '.tmp', 'w'), ensure_ascii=False, indent=1); os.replace(p + '.tmp', p)
EOF
chown $FUID $D/state/status.json 2>/dev/null
echo "$(date '+%F %T') end rc=$rc" >> $LOG
exit $rc
