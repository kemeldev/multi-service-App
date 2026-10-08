FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
ARG VITE_PY_API=/api/py
ARG VITE_NODE_API=/api/node
ARG VITE_POLL_MS=5000
ENV VITE_PY_API=$VITE_PY_API VITE_NODE_API=$VITE_NODE_API VITE_POLL_MS=$VITE_POLL_MS
RUN npm run build

FROM nginx:1.27-alpine
RUN apk update && apk upgrade --no-cache
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY config.js.template /usr/share/nginx/html/config.js.template
COPY 20-generate-config.sh /docker-entrypoint.d/20-generate-config.sh
RUN chmod +x /docker-entrypoint.d/20-generate-config.sh && \
    chown -R nginx:nginx /usr/share/nginx/html /var/cache/nginx /var/run && \
    touch /var/run/nginx.pid && \
    chown nginx:nginx /var/run/nginx.pid
USER nginx
EXPOSE 80