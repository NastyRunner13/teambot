# TeamBot server + web app. Agent computers are separate containers it starts through the Docker socket.
FROM node:22-bookworm-slim
RUN corepack enable
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY computer/computerd/package.json computer/computerd/
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
RUN pnpm --filter @teambot/web build

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 TEAMBOT_DATA_DIR=/data NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8787
VOLUME ["/data"]
CMD ["pnpm", "--filter", "@teambot/server", "start"]
