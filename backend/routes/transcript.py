import re

from fastapi import APIRouter, HTTPException, Query, Response

from backend.models import TranscriptResponse
from backend.services import pdf_service, transcript_service
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


def _fetch_transcript(video_id: str, lang: str | None) -> dict:
    """Validates the ID, fetches the transcript, and maps service errors to HTTP errors."""
    if not is_valid_video_id(video_id):
        raise HTTPException(status_code=400, detail=f"'{video_id}' is not a valid YouTube video ID.")

    cfg = get_config()["transcript"]
    languages = [lang] if lang else [cfg["default_language"], *cfg["fallback_languages"]]

    try:
        return transcript_service.get_transcript(video_id, languages)
    except transcript_service.TranscriptsDisabledError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.LanguageNotAvailableError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.VideoNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except transcript_service.TranscriptFetchError as exc:
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/transcript/{video_id}", response_model=TranscriptResponse)
def get_transcript(video_id: str, lang: str | None = Query(default=None)) -> TranscriptResponse:
    result = _fetch_transcript(video_id, lang)
    return TranscriptResponse(video_id=video_id, language=result["language"], cues=result["cues"])


@router.get("/transcript/{video_id}/pdf")
def download_transcript_pdf(
    video_id: str,
    lang: str | None = Query(default=None),
    title: str | None = Query(default=None, max_length=300),
) -> Response:
    result = _fetch_transcript(video_id, lang)
    pdf_bytes = pdf_service.build_transcript_pdf(video_id, result["language"], result["cues"], title)

    # ASCII-only filename keeps the header valid; fall back to the video ID.
    safe_title = re.sub(r"[^A-Za-z0-9 _-]+", "", title or "")
    safe_title = re.sub(r"\s+", " ", safe_title).strip()[:80]
    filename = f"{safe_title or video_id} - transcript.pdf"
    log.info("transcript_pdf_built", video_id=video_id, bytes=len(pdf_bytes))
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
