# syntax=docker/dockerfile:1.7
# ---------- production dependencies only ----------
FROM node:22-slim AS deps
WORKDIR /app
# Only the manifests: this layer rebuilds only when dependencies change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# ---------- runtime ----------
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node . .
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=$COMMIT_SHA \
    BUILD_TIME=$BUILD_TIME
USER 1000:1000
EXPOSE 8002
CMD ["node", "server.js"]
