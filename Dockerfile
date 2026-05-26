# Combined single-image build: Node service + Python sidecar in the same container.
# For a cleaner deployment, see docker-compose.yml which runs them as two services.

# --- Stage 1: build the Node app ---
FROM node:18-alpine AS node-build
WORKDIR /home/node/app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json index.ts ./
COPY lib ./lib
RUN npm run build

# --- Stage 2: runtime with both Node and Python ---
FROM python:3.12-slim AS runtime

# Install Node 18 (alongside Python 3.12) and supervisor to manage both processes.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg supervisor \
    && curl -fsSL https://deb.nodesource.com/setup_18.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Sidecar
COPY sidecar/pyproject.toml /app/sidecar/
COPY sidecar/app.py /app/sidecar/
RUN pip install --no-cache-dir /app/sidecar

# Node app (built artifacts + production deps)
COPY package*.json /app/
RUN npm ci --omit=dev --ignore-scripts
COPY --from=node-build /home/node/app/dist /app/dist

# Supervisor config: run uvicorn (sidecar) and node (web) in the same container.
COPY <<'SUPERVISOR' /etc/supervisor/conf.d/app.conf
[supervisord]
nodaemon=true
user=root
logfile=/dev/null
logfile_maxbytes=0

[program:sidecar]
command=uvicorn app:app --host 127.0.0.1 --port 5001
directory=/app/sidecar
autorestart=true
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0

[program:web]
command=node dist/index.js
directory=/app
environment=LB_SIDECAR_URL="http://127.0.0.1:5001"
autorestart=true
stdout_logfile=/dev/fd/1
stdout_logfile_maxbytes=0
stderr_logfile=/dev/fd/2
stderr_logfile_maxbytes=0
SUPERVISOR

EXPOSE 5000
CMD ["supervisord", "-c", "/etc/supervisor/conf.d/app.conf"]
