import re

# YouTube video IDs are always exactly 11 chars from this alphabet.
_VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")


def is_valid_video_id(video_id: str) -> bool:
    return bool(_VIDEO_ID_RE.match(video_id))
