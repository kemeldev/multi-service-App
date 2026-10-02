# syntax=docker/dockerfile:1.7
# ---------- build the bundle ----------
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# ---------- serve it ----------
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
USER root
RUN chown 101:101 /usr/share/nginx/html
USER 101
COPY --from=build --chown=101:101 /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chmod=755 docker-entrypoint.d/10-runtime-config.sh /docker-entrypoint.d/10-runtime-config.sh
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=$COMMIT_SHA \
    BUILD_TIME=$BUILD_TIME
EXPOSE 8080