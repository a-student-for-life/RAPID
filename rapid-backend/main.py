from fastapi import FastAPI
from routers import incident

app = FastAPI(
    title="RAPID",
    description="Real-time AI Patient Incident Dispatcher",
    version="4.0.0",
)

app.include_router(incident.router, prefix="/api")


@app.get("/health")
async def health():
    return {"status": "ok"}
