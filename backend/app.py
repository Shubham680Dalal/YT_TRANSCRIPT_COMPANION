from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.routes.transcript import router as transcript_router
from backend.utils.logger import get_logger

log = get_logger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


def create_app() -> FastAPI:
    app = FastAPI(title="YT Transcript Companion")

    # Must be registered BEFORE the static mount below - Starlette matches routes in
    # registration order, and a root-mounted StaticFiles would otherwise swallow /api/*
    # requests before they ever reach this router.
    app.include_router(transcript_router, prefix="/api")

    # Serves video.html, transcript.html, css/, js/ - and index.html for "/" (html=True).
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    log.info("app_ready", frontend_dir=str(FRONTEND_DIR))
    return app
