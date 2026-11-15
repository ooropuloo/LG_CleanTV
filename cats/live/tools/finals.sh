#!/bin/sh
# Final screenshots for one pack, ONE AT A TIME.  usage: sh cats/live/tools/finals.sh pixar black
cd "$(dirname "$0")/../../.." || exit 1
S=$1; C=$2; P="dev/shots/live/${S}_${C}_"; B="dev/cat.html?style=${S}-live&coat=${C}"
shot() { node dev/shot.mjs "$P$1.png" "$B&$2" | head -c 400; echo; }
shot final_clean    "t=4&info=0"
shot final_ui       "t=4&ui=1"
shot final_sheet    "sheet=8&t0=0&t1=6"
shot final_eyes     "t=4&gaze=0.9,0.92&zoom=${EYEZOOM:-0.33,0.36,0.34,0.34}&info=0"
shot final_extremes "t=1&extremes=1"
shot final_tv       "t=4&q=tv"
if [ "$C" = black ]; then
  shot final_sleepy "t=5&mood=sleepy"
  shot final_night  "t=5&hour=22&ui=1"
fi
