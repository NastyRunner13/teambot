#!/bin/sh
set -e

if [ "$(id -u)" = 0 ]; then
  # Fail closed: until the TeamBot server applies this computer's network rules, nothing may leave it except
  # loopback and replies on connections made to it (the server reaching computerd and VNC). This runs before any
  # of the agent's own programs, on every start, including restarts Docker does by itself.
  if iptables -F OUTPUT 2>/dev/null; then
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -m conntrack --ctdir REPLY -j ACCEPT
    iptables -A OUTPUT -j REJECT
    ip6tables -F OUTPUT 2>/dev/null || true
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -m conntrack --ctdir REPLY -j ACCEPT 2>/dev/null || true
    ip6tables -A OUTPUT -j REJECT 2>/dev/null || true
  else
    echo "entrypoint: could not block the network before start (no NET_ADMIN); the server's rules still apply once set" >&2
  fi
  # Everything else runs as the agent, and nothing it starts (sudo included) can get NET_ADMIN back to change the rules.
  exec setpriv --reuid=agent --regid=agent --init-groups --inh-caps=-all --bounding-set=-net_admin "$0" "$@"
fi

mkdir -p /home/agent/workspace /home/agent/.config
: "${VNC_PASSWORD:=teambot}"
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vncpass >/dev/null 2>&1
exec /usr/bin/supervisord -c /etc/teambot/supervisord.conf
