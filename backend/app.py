import asyncio
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from backend.routes.progress import router as progress_router
from backend.routes.transcript import router as transcript_router
from backend.services import progress_service
from backend.utils.config_loader import get_config
from backend.utils.logger import get_logger

log = get_logger(__name__)

FRONTEND_DIR = Path(__file__).parent.parent / "frontend"


async def _flush_progress_periodically(interval_seconds: float) -> None:
    # While a video plays, heartbeats only update memory - write them to the sheet
    # every few minutes so a crash loses at most one interval.
    store = progress_service.get_store()
    while True:
        await asyncio.sleep(interval_seconds)
        await asyncio.to_thread(store.flush)


@asynccontextmanager
async def lifespan(app: FastAPI):
    progress_service.get_store()  # load the sheet up front
    interval = get_config()["progress"]["flush_interval_seconds"]
    flush_task = asyncio.create_task(_flush_progress_periodically(interval))
    try:
        yield
    finally:
        # Runs on Ctrl+C: save whatever was playing at that moment.
        flush_task.cancel()
        progress_service.flush_on_shutdown()


def create_app() -> FastAPI:
    app = FastAPI(title="YT Transcript Companion", lifespan=lifespan)

    # Must be registered BEFORE the static mount below - Starlette matches routes in
    # registration order, and a root-mounted StaticFiles would otherwise swallow /api/*
    # requests before they ever reach this router.
    app.include_router(transcript_router, prefix="/api")
    app.include_router(progress_router, prefix="/api")

    # Serves video.html, transcript.html, css/, js/ - and index.html for "/" (html=True).
    app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")

    log.info("app_ready", frontend_dir=str(FRONTEND_DIR))
    return app
