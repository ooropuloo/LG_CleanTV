#!/bin/sh
# Final screenshots for one v2 scene, ONE AT A TIME.
#   sh cats/live/tools/finals2.sh <scene-id> <style> <pack> <face zoom x,y,s> [eye zoom x,y,s]
# writes dev/shots/live2/<scene>_{clean,ui,sheet,tv,face,extremes,gazeL,gazeR}.png  (+ _face.txt rigidity numbers)
cd "$(dirname "$0")/../../.." || exit 1
SC=$1; ST=$2; PK=$3; FZ=$4; EZ=${5:-$4}
O="dev/shots/live2/${SC}_"; B="dev/cat.html?style=${ST}&coat=${PK}"; T=dev/shots/live2/_tmp
mkdir -p $T
shot() { node dev/shot.mjs "$1" "$B&$2" | head -c 300; echo; }
shot ${O}clean.png    "t=4&info=0"
shot ${O}ui.png       "t=4&ui=1"
shot ${O}sheet.png    "sheet=8&t0=0&t1=10.5"
shot ${O}tv.png       "t=4&q=tv"
shot ${O}extremes.png "t=1&extremes=1"
shot ${O}gazeL.png    "t=4&gaze=0.05,0.92&zoom=${EZ},${EZ##*,}&info=0"
shot ${O}gazeR.png    "t=4&gaze=0.95,0.92&zoom=${EZ},${EZ##*,}&info=0"
for t in 1 2.5 4 5.5 7 9; do shot $T/${SC}_f$t.png "t=$t&zoom=${FZ},${FZ##*,}&info=0"; done
python cats/live/tools/rigid_check.py ${O}face.png $T/${SC}_f1.png $T/${SC}_f2.5.png $T/${SC}_f4.png $T/${SC}_f5.5.png $T/${SC}_f7.png $T/${SC}_f9.png | tee ${O}face.txt
node dev/shot.mjs $T/bench.png "$B&q=tv&bench=120" | grep -o '"calls":[0-9]*\|"triangles":[0-9]*\|"benchMs":[0-9.]*\|"jsMs":[0-9.]*\|"initMs":[0-9]*' | tr '\n' ' '; echo
node dev/shot.mjs $T/bench.png "$B&bench=120" | grep -o '"benchMs":[0-9.]*' ; echo
