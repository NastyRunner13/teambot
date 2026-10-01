# TeamBot agent computer: one of these runs per agent.
# Xvfb desktop + Chromium (driven over CDP) + x11vnc for live view + computerd (the tool API).

FROM node:22-bookworm-slim AS computerd-build
WORKDIR /build
COPY computerd/package.json computerd/tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY computerd/src ./src
RUN npx tsc -p tsconfig.json && npm prune --omit=dev --no-audit --no-fund

FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc x11-utils fluxbox xterm supervisor sudo xdotool scrot iptables \
      ca-certificates curl wget git jq unzip zip procps less nano \
      python3 python3-pip python3-venv \
      fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Coding agents an agent can hand programming work to (run_coding_agent). Each needs its own API key,
# stored as a TeamBot secret (ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY). They add ~750 MB;
# build with --build-arg CODING_AGENTS= to leave them out, or list only the ones you want.
ARG CODING_AGENTS="@anthropic-ai/claude-code @openai/codex @google/gemini-cli"
RUN if [ -n "$CODING_AGENTS" ]; then npm install -g --no-audit --no-fund $CODING_AGENTS && npm cache clean --force; fi

# The node image ships a uid-1000 "node" user; rename it to "agent".
RUN usermod -l agent -d /home/agent -m node && groupmod -n agent node \
    && echo "agent ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/agent && chmod 440 /etc/sudoers.d/agent \
    && mkdir -p /shared /opt/computerd /etc/teambot /etc/chromium/policies/managed \
    && chown agent:agent /shared

COPY --from=computerd-build /build/dist /opt/computerd/dist
COPY --from=computerd-build /build/node_modules /opt/computerd/node_modules
COPY computerd/package.json /opt/computerd/package.json
COPY supervisord.conf /etc/teambot/supervisord.conf
COPY entrypoint.sh start-chromium.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/start-chromium.sh

# The entrypoint starts as root only to block the network before anything else runs, then becomes the agent.
WORKDIR /home/agent
ENV DISPLAY=:1 HOME=/home/agent USER=agent SCREEN_SIZE=1280x800
EXPOSE 5900 7070
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
