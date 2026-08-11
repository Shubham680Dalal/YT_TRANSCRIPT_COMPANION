from youtube_transcript_api import (
    YouTubeTranscriptApi,
    TranscriptsDisabled,
    NoTranscriptFound,
    VideoUnavailable,
)

from backend.utils.logger import get_logger

log = get_logger(__name__)


class TranscriptsDisabledError(Exception):
    """Video owner has disabled captions entirely."""


class LanguageNotAvailableError(Exception):
    """Captions exist, but not in any of the requested languages."""

    def __init__(self, requested_languages: list[str], available_languages: list[str]):
        self.requested_languages = requested_languages
        self.available_languages = available_languages
        super().__init__(
            f"Not available in {requested_languages}. Available: {available_languages}"
        )


class VideoNotFoundError(Exception):
    """Video is deleted, private, or never existed."""


class TranscriptFetchError(Exception):
    """Unexpected failure (network hiccup, library-internal change, etc)."""


# youtube-transcript-api's YouTubeTranscriptApi() is a stateless client (just wraps a
# requests session) - lazy singleton avoids re-creating it on every request.
_api: YouTubeTranscriptApi | None = None


def _get_api() -> YouTubeTranscriptApi:
    global _api
    if _api is None:
        _api = YouTubeTranscriptApi()
        log.info("transcript_api_client_ready")
    return _api


def _list_available_language_codes(video_id: str) -> list[str]:
    try:
        listing = _get_api().list(video_id)
        return sorted({t.language_code for t in listing})
    except Exception:
        # Best-effort only - if even listing fails, just report an empty list
        # rather than letting a secondary failure mask the original error.
        return []


def get_transcript(video_id: str, languages: list[str]) -> dict:
    """Fetch transcript for video_id.

    Returns {"language": <code actually matched>, "cues": [{"text", "start", "duration"}, ...]}.
    fetch() already returns cues sorted by start time.
    """
    api = _get_api()
    try:
        fetched = api.fetch(video_id, languages=languages)
    except TranscriptsDisabled:
        log.info("transcript_disabled", video_id=video_id)
        raise TranscriptsDisabledError(f"No captions available for video {video_id}")
    except NoTranscriptFound:
        available = _list_available_language_codes(video_id)
        log.info(
            "transcript_language_unavailable",
            video_id=video_id,
            requested=languages,
            available=available,
        )
        raise LanguageNotAvailableError(languages, available)
    except VideoUnavailable:
        log.info("transcript_video_unavailable", video_id=video_id)
        raise VideoNotFoundError(f"Video not found or unavailable: {video_id}")
    except Exception as exc:
        log.error("transcript_fetch_failed", video_id=video_id, error=str(exc))
        raise TranscriptFetchError("Could not retrieve transcript from YouTube. Try again.")

    return {"language": fetched.language_code, "cues": fetched.to_raw_data()}
