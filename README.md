# RAPID (Real-time AI Patient Incident Dispatcher)

RAPID is an intelligent, AI-driven emergency response and dispatch system designed to coordinate ambulances and medical resources during critical incidents in real-time. By leveraging a multi-tier AI routing chain and dynamic mapping, RAPID ensures fast, efficient, and resilient dispatching even during complex emergencies.

## Features

- **Multi-Tier AI Routing:** Utilizes Groq (Llama-3.3-70b) as the primary engine for high-speed incident routing, with a robust fallback to Google Gemini (2.0 Flash Vision) for resilient decision-making.
- **Dynamic Maps & ETAs:** Integrates Google Maps Platform for real-time ETAs and routing, backed by OpenRouteService (ORS) and Leaflet as open-source fallbacks.
- **Real-time Synchronization:** Powered by Firebase/Firestore to keep incident histories, live crew assignments, and unit coordinates synchronized instantly across all dispatchers.
- **Interactive Dispatch Dashboard:** A modern, responsive React-based frontend providing a live overview of incidents, unit locations, and AI-driven dispatch recommendations.
- **Resilient Fallback Mode:** Designed to function effectively even if cloud or AI services go offline or hit rate limits, ensuring emergency operations are never fully interrupted.

## Tech Stack

- **Backend:** Python, FastAPI
- **Frontend:** React, Vite, Tailwind CSS, Recharts
- **AI/ML:** Groq API, Google Gemini API
- **Mapping:** Google Maps API, React-Leaflet, OpenRouteService (ORS), Nominatim
- **Database:** Firebase / Cloud Firestore
- **Deployment:** Docker, Google Cloud Run

## Getting Started

Please refer to the [STARTUP.md](STARTUP.md) file for comprehensive, step-by-step instructions on configuring the environment variables and running the project locally.

### Prerequisites
- Node.js (for the frontend)
- Python 3.9+ (for the backend)
- API Keys for Google Maps, Groq, and Gemini (optional, but recommended for the full feature set).

### Quick Start (Development)

1. **Backend Setup:**
   ```bash
   cd rapid-backend
   pip install -r requirements.txt
   cp .env.example .env
   uvicorn main:app --reload --port 8000
   ```
   *The API will be available at http://localhost:8000/docs*

2. **Frontend Setup:**
   ```bash
   cd rapid-frontend
   npm install
   npm run dev
   ```
   *The frontend will be available at http://localhost:5173*

## Demo Mode

RAPID includes a built-in interactive demo (e.g., "Kurla Station Derailment") to test the dispatch logic and fallback systems without requiring a full Google Cloud deployment. 

1. Start both the backend and frontend servers as described above.
2. Click the **"Kurla Station Derailment"** demo button in the UI.
3. Click **"Dispatch RAPID"** to watch the simulated ambulance coordination on the map.
4. You can click **"Simulate AI Failure"** to test how the system gracefully routes traffic to fallback engines.
