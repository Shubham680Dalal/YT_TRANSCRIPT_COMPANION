from pydantic import BaseModel


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
