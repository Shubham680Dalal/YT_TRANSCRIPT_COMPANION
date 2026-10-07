import datetime as dt
from typing import Literal

from pydantic import BaseModel, Field


class TranscriptCue(BaseModel):
    text: str
    start: float
    duration: float


class TranscriptResponse(BaseModel):
    video_id: str
    language: str
    cues: list[TranscriptCue]


class ErrorResponse(BaseModel):
    detail: str


class ProgressUpdate(BaseModel):
    position: float = Field(ge=0)
    duration: float = Field(default=0, ge=0)
    title: str | None = Field(default=None, max_length=300)
    # "playing" = periodic heartbeat (memory only); anything else also writes the sheet.
    # "opened" = video just loaded (records the visit; position 0 never overwrites a saved spot).
    state: Literal["opened", "playing", "paused", "ended", "closed"]


class ProgressRecord(BaseModel):
    video_id: str
    title: str
    position: float
    duration: float
    status: str
    updated_at: dt.datetime
