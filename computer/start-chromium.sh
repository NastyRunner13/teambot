#!/bin/sh
# Chromium runs on the visible desktop so humans can watch and take over.
# --no-sandbox: the container is the sandbox; Chromium's own sandbox needs privileges we don't grant.
# --test-type hides the "unsupported command-line flag" warning bar that --no-sandbox triggers.
# --start-maximized alone: fluxbox fits the window above its taskbar. With --window-position/--window-size too,
# Chromium stays unmaximized at y=-4, its tab strip cut off at the top and its bottom under the taskbar.
until xdpyinfo -display :1 >/dev/null 2>&1; do sleep 0.2; done
PROFILE=/home/agent/.config/chromium-profile
rm -f "$PROFILE/SingletonLock" "$PROFILE/SingletonSocket" "$PROFILE/SingletonCookie"
exec chromium \
  --no-sandbox --test-type --disable-dev-shm-usage --disable-gpu \
  --no-first-run --no-default-browser-check --password-store=basic \
  --disable-features=Translate,MediaRouter --disable-session-crashed-bubble \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PROFILE" \
  --start-maximized \
  about:blank
