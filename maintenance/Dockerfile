FROM python:3.12-slim

# psycopg[binary] ships a pre-built wheel, so no compiler is needed and a
# multi-stage build would add nothing here.
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY cleanup.py .

# Non-root, numeric UID so Kubernetes can verify runAsNonRoot.
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin cleanup
USER 10001

# Exec form, so python is PID 1 and receives signals directly.
# (Sub-lab 3.5 troubleshooting: shell form breaks signal delivery.)
ENTRYPOINT ["python", "cleanup.py"]
