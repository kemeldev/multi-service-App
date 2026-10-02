# syntax=docker/dockerfile:1.7
# ---------- builder ----------
FROM python:3.12-slim AS builder
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
# Dependency manifest first: this layer only rebuilds when requirements.txt changes.
COPY requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip \
 && /opt/venv/bin/pip install -r requirements.txt
# ---------- runtime ----------
FROM python:3.12-slim AS runtime
ENV PATH="/opt/venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1
RUN groupadd --gid 10001 app \
 && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=builder /opt/venv /opt/venv
# Application source last: the layer that changes most often is the cheapest to rebuild.
COPY --chown=10001:10001 . .
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=$COMMIT_SHA \
    BUILD_TIME=$BUILD_TIME
USER 10001:10001
EXPOSE 8001
CMD ["python", "main.py"]
