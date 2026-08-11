import pytest
from youtube_transcript_api import TranscriptsDisabled, VideoUnavailable, NoTranscriptFound

from backend.services import transcript_service


class _FakeFetchedTranscript:
    def __init__(self, language_code, raw):
        self.language_code = language_code
        self._raw = raw

    def to_raw_data(self):
        return self._raw


class _FakeTranscript:
    def __init__(self, language_code):
        self.language_code = language_code


class _FakeApi:
    """Stands in for YouTubeTranscriptApi so tests never touch the network."""

    def __init__(self, fetch_side_effect, list_result=None):
        self._fetch_side_effect = fetch_side_effect
        self._list_result = list_result or []

    def fetch(self, video_id, languages=None, preserve_formatting=False):
        if isinstance(self._fetch_side_effect, Exception):
            raise self._fetch_side_effect
        return self._fetch_side_effect(video_id, languages)

    def list(self, video_id):
        return self._list_result


@pytest.fixture(autouse=True)
def reset_singleton(monkeypatch):
    # get_transcript() lazily caches a client on first call - reset it between tests
    # so each test starts from a clean slate regardless of run order.
    monkeypatch.setattr(transcript_service, "_api", None)


def _install_fake_api(monkeypatch, fake_api):
    monkeypatch.setattr(transcript_service, "_get_api", lambda: fake_api)


def test_get_transcript_success(monkeypatch):
    raw = [{"text": "hi", "start": 0.0, "duration": 1.0}]
    fake = _FakeApi(fetch_side_effect=lambda vid, langs: _FakeFetchedTranscript("en", raw))
    _install_fake_api(monkeypatch, fake)

    result = transcript_service.get_transcript("aircAruvnKk", ["en"])

    assert result == {"language": "en", "cues": raw}


def test_transcripts_disabled_maps_to_custom_exception(monkeypatch):
    fake = _FakeApi(fetch_side_effect=TranscriptsDisabled("aircAruvnKk"))
    _install_fake_api(monkeypatch, fake)

    with pytest.raises(transcript_service.TranscriptsDisabledError):
        transcript_service.get_transcript("aircAruvnKk", ["en"])


def test_video_unavailable_maps_to_custom_exception(monkeypatch):
    fake = _FakeApi(fetch_side_effect=VideoUnavailable("AAAAAAAAAAA"))
    _install_fake_api(monkeypatch, fake)

    with pytest.raises(transcript_service.VideoNotFoundError):
        transcript_service.get_transcript("AAAAAAAAAAA", ["en"])


def test_no_transcript_found_lists_available_languages(monkeypatch):
    fake = _FakeApi(
        fetch_side_effect=NoTranscriptFound("aircAruvnKk", ["fr"], None),
        list_result=[_FakeTranscript("en"), _FakeTranscript("de")],
    )
    _install_fake_api(monkeypatch, fake)

    with pytest.raises(transcript_service.LanguageNotAvailableError) as exc_info:
        transcript_service.get_transcript("aircAruvnKk", ["fr"])

    assert exc_info.value.available_languages == ["de", "en"]


def test_unexpected_error_wrapped_as_fetch_error(monkeypatch):
    fake = _FakeApi(fetch_side_effect=RuntimeError("network blew up"))
    _install_fake_api(monkeypatch, fake)

    with pytest.raises(transcript_service.TranscriptFetchError):
        transcript_service.get_transcript("aircAruvnKk", ["en"])
