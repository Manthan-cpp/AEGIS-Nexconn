from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
import logging
import os
from urllib.parse import urlparse

from routers.sos import router as sos_router
from routers.companion import router as companion_router
from routers.legal import router as legal_router
from routers.responder import router as responder_router
from routers.voice import router as voice_router
from routers.email import router as email_router
from routers.health import router as health_router
from routers.direct_messages import router as direct_messages_router
from routers.nexconn import router as nexconn_router
from services.email_queue import start_email_queue_worker, stop_email_queue_worker
from services.nexconn_server import nexconn_configured

load_dotenv()

@asynccontextmanager
async def lifespan(_app: FastAPI):
    worker_enabled = os.getenv("EMAIL_QUEUE_WORKER_ENABLED", "true").strip().casefold() not in {"0", "false", "no", "off"}
    if worker_enabled:
        start_email_queue_worker()
    try:
        yield
    finally:
        if worker_enabled:
            stop_email_queue_worker()


app = FastAPI(title="Aegis Backend", version="0.1.0", lifespan=lifespan)

logger = logging.getLogger("aegis.cors")

DEV_ORIGINS = ("http://localhost:3000", "http://127.0.0.1:3000")


def _normalize_origin(raw: str) -> str | None:
    """Return a canonical scheme://host[:port] origin, or None if it is not one."""
    origin = raw.strip().rstrip("/")
    if not origin or "*" in origin:
        return None
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return None
    return f"{parsed.scheme}://{parsed.netloc}"


def _is_production() -> bool:
    return os.getenv("APP_ENV", "development").strip().casefold() in {"production", "prod"}


def _resolve_allowed_origins() -> list[str]:
    """Explicit origins only. Production never falls back to the dev origins."""
    configured = os.getenv("ALLOWED_ORIGINS", "").strip()
    origins: list[str] = []
    for entry in configured.split(",") if configured else []:
        origin = _normalize_origin(entry)
        if origin is None:
            if entry.strip():
                logger.warning("Ignoring invalid ALLOWED_ORIGINS entry: %r", entry.strip())
            continue
        if origin not in origins:
            origins.append(origin)
    if origins:
        return origins
    if _is_production():
        logger.error(
            "APP_ENV=production without a valid ALLOWED_ORIGINS list; "
            "cross-origin browser requests will be blocked."
        )
        return []
    return list(DEV_ORIGINS)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_resolve_allowed_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sos_router)
app.include_router(companion_router)
app.include_router(legal_router)
app.include_router(responder_router)
app.include_router(voice_router)
app.include_router(email_router)
app.include_router(health_router)
app.include_router(direct_messages_router)
app.include_router(nexconn_router)


@app.get("/health")
def health():
    return {
        "status": "ok",
        "service": "aegis-backend",
        "nexconn_configured": nexconn_configured(),
    }


# Routers are added phase by phase:
# Phase 2: from routers import sos
# Phase 4: legal rights RAG router is active.
# Phase 5: from routers import cases
