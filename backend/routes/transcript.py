from fastapi import APIRouter, HTTPException, Query

from backend.models import TranscriptResponse
from backend.services import transcript_service
from backend.utils.config_loader import get_config
from backend.utils.video_id_validator import is_valid_video_id
from backend.utils.logger import get_logger

log = get_logger(__name__)

router = APIRouter()


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/config")
def config() -> dict:
    """Sync-tuning values the frontend needs, so they're never duplicated in JS."""
    cfg = get_config()
    return cfg["sync"]


@router.get("/transcript/{video_id}", response_model=TranscriptResponse)
def get_transcript(video_id: str, lang: str | None = Query(default=None)) -> TranscriptResponse:
    if not is_valid_video_id(video_id):
        raise HTTPException(status_code=400, detail=f"'{video_id}' is not a valid YouTube video ID.")

    cfg = get_config()["transcript"]
    languages = [lang] if lang else [cfg["default_language"], *cfg["fallback_languages"]]

    try:
        result = transcript_service.get_transcript(video_id, languages)
    except transcript_service.TranscriptsDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.LanguageNotAvailableError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.VideoNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.TranscriptFetchError as exc:
        raise HTTPException(status_code=502, detail=str(exc))

    return TranscriptResponse(video_id=video_id, language=result["language"], cues=result["cues"])
