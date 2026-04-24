FROM python:3.12-slim

# Prevent Python from buffering logs so Cloud Run / Cloud Logging see them
# in real time, and avoid writing .pyc files inside the read-only image.
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Minimal system deps — curl for the Cloud Run healthcheck probe.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so application-code edits don't bust the layer cache.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend. `.dockerignore` keeps secrets (.env, service
# account JSON, __pycache__, tests) out of the image.
COPY . .

# Cloud Run injects PORT at runtime (defaults to 8080). Use shell form so
# $PORT expands — the exec form would treat it as a literal string.
ENV PORT=8080
EXPOSE 8080

CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
