#!/bin/sh
# Chromium runs on the visible desktop so humans can watch and take over.
# --no-sandbox: the container is the sandbox; Chromium's own sandbox needs privileges we don't grant.
# --test-type hides the "unsupported command-line flag" warning bar that --no-sandbox triggers.
until xdpyinfo -display :1 >/dev/null 2>&1; do sleep 0.2; done
PROFILE=/home/agent/.config/chromium-profile
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
W=${SCREEN_SIZE%x*}
H=${SCREEN_SIZE#*x}
exec chromium \
  --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-features=Translate,MediaRouter --disable-session-crashed-bubble \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --window-position=0,0 --window-size="$W,$H" --start-maximized \
  about:blank
