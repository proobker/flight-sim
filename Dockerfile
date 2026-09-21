# syntax=docker/dockerfile:1

# ── Stage 1: build the frontend ─────────────────────────────────────────────
FROM node:22-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# ── Stage 2: runtime ────────────────────────────────────────────────────────
FROM python:3.14-slim AS runtime
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PORT=10000
WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=frontend /build/frontend/dist ./frontend/dist

EXPOSE 10000
CMD ["sh", "-c", "python -m backend.run --serve --host 0.0.0.0 --port ${PORT:-10000} --aircraft 60"]
