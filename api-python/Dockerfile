FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ARG COMMIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV COMMIT_SHA=$COMMIT_SHA BUILD_TIME=$BUILD_TIME
RUN useradd -u 10001 -m appuser
USER 10001
EXPOSE 8001
CMD ["python", "main.py"]
