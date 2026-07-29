# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# No install scripts: better-sqlite3 ships a prebuilt binding for every platform
# this image runs on, so skipping them avoids dragging a C toolchain into the
# build and makes the result independent of npm's script-approval policy.
RUN npm ci --ignore-scripts
COPY tsconfig.base.json ./
COPY server/ server/
COPY web/ web/
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PHILO_PORT=3000 \
    PHILO_DATA_DIR=/data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public
# SQL migrations are read at startup, not compiled into dist.
COPY --from=build /app/server/drizzle ./server/drizzle

# Pre-created and owned by `node` so a fresh named volume inherits the
# ownership and the unprivileged process can write to it.
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- "http://127.0.0.1:${PHILO_PORT}/version" || exit 1
CMD ["node", "server/dist/index.js"]
