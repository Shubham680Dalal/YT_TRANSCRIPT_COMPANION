# YT Transcript Companion

Solves one problem: watching a YouTube course video fullscreen on one monitor while a
transcript follows along, fullscreen, on the other — without ever manually re-syncing
the two.

- **Window A** (`video.html`) embeds the real YouTube player (YouTube's official IFrame
  Player API — full native controls, real fullscreen).
- **Window B** (`transcript.html`) shows the transcript, auto-scrolling and highlighting
  the current line as Window A plays.
- The two stay in sync via the browser's `BroadcastChannel` API — no server round-trip,
  no manual pausing-both-windows.

No API keys, no paid services. Transcripts come from the free, open-source
`youtube-transcript-api`; the player uses YouTube's free, unauthenticated embed API.

## Setup

```bash
cd YT_TRANSCRIPT_COMPANION
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
```

## Run

```bash
python main.py
```

Then open **http://127.0.0.1:8000** — it redirects to the video window.

1. Paste a YouTube URL (or bare video ID) and click **Load Video**.
2. Click **Open Transcript Window →** — a second browser window opens.
3. Drag Window A to monitor 1, use the player's own fullscreen button.
4. Drag Window B to monitor 2, maximize/`F11` it.
5. Play, pause, and seek entirely from Window A — Window B follows automatically.

If you close Window B and reopen it mid-playback, it resyncs to the correct time
within about 300ms (no need to re-pause/re-play anything).

## Troubleshooting

- **"This video has no captions available"** — the video owner disabled captions
  entirely. Nothing to do here; try a different video.
- **"This video's owner has disabled embedding"** (shown in Window A only) — some
  videos can't be embedded outside youtube.com. Their transcript can often still be
  fetched, so Window B may work even if Window A can't play it.
- **Transcripts stop fetching entirely** — `youtube-transcript-api` talks to YouTube's
  internal caption endpoints, which occasionally shift. Try
  `pip install --upgrade youtube-transcript-api` first.
- **`/api/docs`** — FastAPI's interactive API page. Useful for testing
  `/api/transcript/{video_id}` directly in a browser, independent of any frontend JS,
  when debugging.

## Project layout

```
main.py                # entrypoint - python main.py
config.yaml             # port, default caption language, sync-tuning constants
backend/
  app.py                 # FastAPI app factory
  models.py               # Pydantic response models
  routes/transcript.py     # /api/health, /api/config, /api/transcript/{video_id}
  services/transcript_service.py  # wraps youtube-transcript-api
  utils/                    # config_loader, logger, video_id_validator
frontend/
  video.html / js/video.js         # Window A - player + sync broadcaster
  transcript.html / js/transcript.js  # Window B - transcript + sync follower
  js/youtube-utils.js               # shared URL -> video ID parsing
tests/                    # pytest, no network calls needed
```

## Known v1 limits (by design, not bugs)

- No note-taking pane yet.
- Sync is one-way: control from Window A only (clicking a transcript line doesn't seek
  the video).
- Highlighting is per-caption-line, not per-word — YouTube's transcript data doesn't
  expose word-level timestamps.
- Window B is tied to one `video_id` at a time; loading a new video in Window A
  requires reopening Window B (click "Open Transcript Window" again).
