from fastapi import APIRouter, HTTPException, Query

from backend.models import ProgressRecord, ProgressUpdate
from backend.services import progress_service
from backend.utils.video_id_validator import is_valid_video_id

router = APIRouter()


def _check_id(video_id: str) -> None:
    if not is_valid_video_id(video_id):
        raise HTTPException(status_code=400, detail=f"'{video_id}' is not a valid YouTube video ID.")


@router.get("/progress", response_model=list[ProgressRecord])
def list_progress(limit: int = Query(default=20, ge=1, le=200)) -> list[dict]:
    """Recently watched videos, newest first - feeds the link box suggestions."""
    return progress_service.get_store().list_recent(limit)


@router.get("/progress/{video_id}", response_model=ProgressRecord)
def get_progress(video_id: str) -> dict:
    _check_id(video_id)
    record = progress_service.get_store().get(video_id)
    if record is None:
        raise HTTPException(status_code=404, detail="No saved progress for this video.")
    return record


# POST (not PUT) so the page can use navigator.sendBeacon() when the tab closes.
@router.post("/progress/{video_id}", response_model=ProgressRecord)
def save_progress(video_id: str, update: ProgressUpdate) -> dict:
    _check_id(video_id)
    store = progress_service.get_store()
    record = store.update(video_id, update.position, update.duration, update.title, update.state)
    if update.state != "playing":
        # Pause / end / switch / tab close: write the sheet now. Heartbeats while playing
        # stay in memory and are written by the periodic flush in backend/app.py.
        store.flush()
    return record
