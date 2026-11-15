#!/bin/sh
# add the tv-home factory lines to root's crontab (idempotent). Uses this checkout's location.
TV=$(cd "$(dirname "$0")/.." && pwd)
crontab -l 2>/dev/null | grep -v "$TV/factory/run.sh" | grep -v '# tv-home factory' > /tmp/cron.new
cat >> /tmp/cron.new <<X
# tv-home factory (scene generator, $TV/factory/README.md). Disable: touch $TV/factory-data/DISABLED
30 3 * * 2,5 sh $TV/factory/run.sh scheduled >/dev/null 2>&1
*/5 * * * * sh $TV/factory/run.sh watch >/dev/null 2>&1
X
crontab /tmp/cron.new && rm -f /tmp/cron.new
crontab -l | tail -5
