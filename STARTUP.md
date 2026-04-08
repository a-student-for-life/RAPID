# RAPID v4 — Startup Guide

## Backend

```bash
cd rapid-backend

# First time: install dependencies
pip install -r requirements.txt

# Copy and configure env
cp .env.example .env
# Edit .env: set GOOGLE_CLOUD_PROJECT to your project ID

# Run locally (fallback mode works without GOOGLE_CLOUD_PROJECT)
uvicorn main:app --reload --port 8000

# API docs: http://localhost:8000/docs
# Health:   http://localhost:8000/health
```

## Frontend

```bash
cd rapid-frontend

# Install dependencies
npm install

# Run dev server (proxies /api to localhost:8000)
npm run dev

# Open: http://localhost:5173
```

## Docker (Cloud Run)

```bash
cd rapid-backend
docker build -t rapid-backend .
docker run -p 8080:8080 \
  -e GOOGLE_CLOUD_PROJECT=your-project-id \
  -e GOOGLE_APPLICATION_CREDENTIALS=/app/key.json \
  -v /path/to/key.json:/app/key.json \
  rapid-backend
```

## Demo (no Google Cloud needed)

1. Start backend: `uvicorn main:app --reload --port 8000`
   - Gemini will be disabled (no GOOGLE_CLOUD_PROJECT) — fallback router handles all routing
2. Start frontend: `npm run dev`
3. Click **"Kurla Station Derailment"** demo button
4. Click **"Dispatch RAPID"**
5. Watch ambulances animate on the map
6. Click **"Simulate AI Failure"** then re-dispatch to demonstrate fallback

## Force fallback mode for demo

- Toggle **"Simulate AI Failure"** in the UI, OR
- Set `GEMINI_TIMEOUT_SECONDS=0.001` in `.env`
