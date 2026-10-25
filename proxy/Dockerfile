FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY nginx.pathbased.conf /etc/nginx/conf.d/default.conf
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q --spider http://localhost:8080/ || exit 1
