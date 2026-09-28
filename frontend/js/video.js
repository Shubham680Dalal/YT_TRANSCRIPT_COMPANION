// Window A: embeds the real YouTube player and broadcasts playback state so the
// transcript window (Window B) can follow along.
//
// Big picture for anyone coming from Python: there's no event loop you write yourself
// here. The browser runs one, and YouTube's IFrame API + setInterval() below are both
// just callbacks registered against it - closer to `asyncio` callbacks than to a
// blocking `while True: ...` loop.

const urlInput = document.getElementById("url-input");
const loadBtn = document.getElementById("load-btn");
const openTranscriptBtn = document.getElementById("open-transcript-btn");
const banner = document.getElementById("banner");

let player = null;
let currentVideoId = null;
let syncChannel = null;
let pendingVideoId = null; // set if "Load Video" is clicked before the IFrame API script is ready
let transcriptWindowRef = null; // tracks the popup so a manual close doesn't strand the button

// Filled in from GET /api/config on page load - see loadSyncConfig() below.
let POLL_INTERVAL_MS = 300;
let SEEK_JUMP_THRESHOLD_SECONDS = 1.5;

let pollTimer = null;
let lastKnownTime = 0;
let lastPollWallClockMs = performance.now();

// Per-video resume positions live in localStorage (browser-only, survives refresh/restart).
const RESUME_KEY_PREFIX = "yt-resume-";
const RESUME_SAVE_INTERVAL_MS = 5000;
const RESUME_MIN_SECONDS = 5; // don't bother "resuming" at 0:02
const RESUME_END_MARGIN_SECONDS = 10; // near the end counts as finished -> start fresh next time
let lastResumeSaveMs = 0;

function getSavedPosition(videoId) {
  try {
    const seconds = parseFloat(localStorage.getItem(RESUME_KEY_PREFIX + videoId));
    return seconds >= RESUME_MIN_SECONDS ? seconds : 0;
  } catch (err) {
    return 0;
  }
}

function savePosition(videoId, seconds) {
  if (!videoId || !player || typeof player.getDuration !== "function") return;
  try {
    const duration = player.getDuration();
    if (seconds < RESUME_MIN_SECONDS || (duration > 0 && seconds >= duration - RESUME_END_MARGIN_SECONDS)) {
      localStorage.removeItem(RESUME_KEY_PREFIX + videoId);
    } else {
      localStorage.setItem(RESUME_KEY_PREFIX + videoId, String(Math.floor(seconds)));
    }
  } catch (err) {
    // Storage unavailable (private window, blocked site data) - resume just won't work.
  }
}

// Recently loaded videos, most recent first - fed into the input's <datalist> so they
// show up as autofill suggestions instead of re-copying links from YouTube.
const RECENT_VIDEOS_KEY = "yt-recent-videos";
const RECENT_VIDEOS_MAX = 20;
const recentVideosList = document.getElementById("recent-videos");

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function getRecentVideos() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_VIDEOS_KEY)) || [];
  } catch (err) {
    return [];
  }
}

function rememberVideo(videoId, title) {
  const recent = getRecentVideos();
  const existing = recent.find((v) => v.id === videoId);
  const entry = { id: videoId, title: title || (existing && existing.title) || "" };
  const updated = [entry, ...recent.filter((v) => v.id !== videoId)].slice(0, RECENT_VIDEOS_MAX);
  try {
    localStorage.setItem(RECENT_VIDEOS_KEY, JSON.stringify(updated));
  } catch (err) {
    // Storage unavailable - suggestions just won't persist.
  }
  renderRecentVideos();
}

function renderRecentVideos() {
  recentVideosList.innerHTML = "";
  for (const video of getRecentVideos()) {
    const option = document.createElement("option");
    option.value = watchUrl(video.id);
    const resumeAt = getSavedPosition(video.id);
    const title = video.title || video.id;
    option.label = resumeAt > 0 ? `${title} · left off at ${formatTimestamp(resumeAt)}` : title;
    recentVideosList.appendChild(option);
  }
}

function formatTimestamp(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function showBanner(message, kind) {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
}

function clearBanner() {
  banner.className = "banner";
  banner.textContent = "";
}

async function loadSyncConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    POLL_INTERVAL_MS = cfg.poll_interval_ms;
    SEEK_JUMP_THRESHOLD_SECONDS = cfg.seek_jump_threshold_seconds;
  } catch (err) {
    // Config endpoint down is not fatal - the hardcoded defaults above still work.
    console.warn("Could not load /api/config, using built-in sync defaults.", err);
  }
}

// YouTube calls this itself once https://www.youtube.com/iframe_api finishes loading.
// Must be a global (window.*) function - this is YouTube's contract, not ours.
window.onYouTubeIframeAPIReady = function () {
  if (pendingVideoId) {
    createPlayer(pendingVideoId);
    pendingVideoId = null;
  }
};

let resumedFromSeconds = 0; // shown as a banner once the player is ready

function createPlayer(videoId) {
  resumedFromSeconds = getSavedPosition(videoId);
  if (player) {
    // Reuse the existing embed instead of re-creating the iframe from scratch.
    player.loadVideoById(videoId, resumedFromSeconds);
    showResumeBanner();
    // onReady only fires once per player, so re-enable here for every later video.
    openTranscriptBtn.disabled = false;
  } else {
    player = new YT.Player("player", {
      videoId: videoId,
      playerVars: { rel: 0, start: Math.floor(resumedFromSeconds) },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }
}

function showResumeBanner() {
  if (resumedFromSeconds > 0) {
    showBanner(`Resumed at ${formatTimestamp(resumedFromSeconds)} - where you left off.`, "info");
  } else {
    clearBanner();
  }
}

function onPlayerReady() {
  showResumeBanner();
  openTranscriptBtn.disabled = false;
  startPolling();
}

function onPlayerStateChange(event) {
  // YT.PlayerState: ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
  if (event.data === YT.PlayerState.PLAYING) {
    broadcastSync("playing", player.getCurrentTime());
    // The title is only known once the video starts - store it so suggestions read nicely.
    const title = player.getVideoData && player.getVideoData().title;
    if (title) rememberVideo(currentVideoId, title);
  } else if (event.data === YT.PlayerState.PAUSED) {
    broadcastSync("paused", player.getCurrentTime());
    savePosition(currentVideoId, player.getCurrentTime());
  } else if (event.data === YT.PlayerState.ENDED) {
    broadcastSync("paused", player.getCurrentTime());
    savePosition(currentVideoId, player.getDuration()); // clears it - finished videos start fresh
  }
  // BUFFERING is deliberately ignored - broadcasting on it just causes transcript flicker.
}

const PLAYER_ERROR_MESSAGES = {
  2: "That doesn't look like a valid YouTube video ID.",
  5: "This video can't be played in the HTML5 player.",
  100: "Video not found - it may have been removed or made private.",
  101: "This video's owner has disabled embedding, so it can't be played here. " +
       "(Its transcript may still work standalone in the transcript window.)",
  150: "This video's owner has disabled embedding, so it can't be played here. " +
       "(Its transcript may still work standalone in the transcript window.)",
};

function onPlayerError(event) {
  showBanner(
    PLAYER_ERROR_MESSAGES[event.data] || "Something went wrong loading this video.",
    "error"
  );
}

function broadcastSync(state, currentTime) {
  if (!syncChannel) return;
  syncChannel.postMessage({
    videoId: currentVideoId,
    state: state,
    currentTime: currentTime,
    playbackRate: player ? player.getPlaybackRate() : 1,
  });
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  lastKnownTime = player.getCurrentTime();
  lastPollWallClockMs = performance.now();

  pollTimer = setInterval(() => {
    if (!player || typeof player.getCurrentTime !== "function") return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING) return;

    const now = player.getCurrentTime();
    const wallClockElapsedSec = (performance.now() - lastPollWallClockMs) / 1000;
    // Expected drift accounts for playback rate so 2x/4x speed is never mistaken for a seek.
    const expectedDrift = wallClockElapsedSec * player.getPlaybackRate();
    const actualDelta = Math.abs(now - lastKnownTime);

    // Whether or not this tick looks like a seek, broadcast a heartbeat anyway - this
    // is what lets a freshly (re)opened transcript window resync within one poll
    // interval, with no separate handshake needed.
    broadcastSync("playing", now);

    if (performance.now() - lastResumeSaveMs >= RESUME_SAVE_INTERVAL_MS) {
      savePosition(currentVideoId, now);
      lastResumeSaveMs = performance.now();
    }

    if (actualDelta > expectedDrift + SEEK_JUMP_THRESHOLD_SECONDS) {
      console.debug("Seek detected", { from: lastKnownTime, to: now });
    }

    lastKnownTime = now;
    lastPollWallClockMs = performance.now();
  }, POLL_INTERVAL_MS);
}

function handleLoadVideo() {
  const videoId = extractVideoId(urlInput.value);
  if (!videoId) {
    showBanner("Couldn't recognize that as a YouTube URL or video ID.", "error");
    return;
  }
  clearBanner();

  // Save the outgoing video's spot before switching away from it.
  if (currentVideoId && player && typeof player.getCurrentTime === "function") {
    savePosition(currentVideoId, player.getCurrentTime());
  }

  currentVideoId = videoId;
  rememberVideo(videoId);
  if (syncChannel) syncChannel.close();
  syncChannel = new BroadcastChannel(`yt-sync-${videoId}`);

  // Put the video in the page URL so a refresh reloads it (and resumes) automatically.
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.set("v", videoId);
  history.replaceState(null, "", pageUrl);
  openTranscriptBtn.disabled = true; // re-enabled in onPlayerReady once the new video loads

  if (typeof YT !== "undefined" && YT.Player) {
    createPlayer(videoId);
  } else {
    // IFrame API script hasn't finished loading yet - onYouTubeIframeAPIReady will
    // pick this up once it fires.
    pendingVideoId = videoId;
  }
}

// window.open() must be called synchronously inside this click handler with no
// await/async gap before it - some browsers silently block popups opened "late".
openTranscriptBtn.addEventListener("click", () => {
  // If the transcript window is still open, just bring it forward instead of
  // reusing the "transcriptWindow" target name, which some browsers won't
  // reliably reopen once the user has manually closed it.
  if (transcriptWindowRef && !transcriptWindowRef.closed) {
    transcriptWindowRef.focus();
    return;
  }

  transcriptWindowRef = window.open(
    `/transcript.html?video_id=${currentVideoId}`,
    "transcriptWindow",
    "width=900,height=800"
  );
});

loadBtn.addEventListener("click", handleLoadVideo);
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") handleLoadVideo();
});

// Picking a suggestion from the dropdown loads it straight away - no extra click needed.
// Browsers report a datalist pick as an input event without a normal typing inputType.
urlInput.addEventListener("input", (e) => {
  if (e.inputType && e.inputType !== "insertReplacementText") return;
  const picked = getRecentVideos().some((v) => watchUrl(v.id) === urlInput.value);
  if (picked) handleLoadVideo();
});

// Refresh the "left off at" labels each time the box is focused.
urlInput.addEventListener("focus", renderRecentVideos);
renderRecentVideos();

// Refresh / tab close: save the exact spot, not just the last 5s checkpoint.
window.addEventListener("pagehide", () => {
  if (currentVideoId && player && typeof player.getCurrentTime === "function") {
    savePosition(currentVideoId, player.getCurrentTime());
  }
});

loadSyncConfig();

const videoFromUrl = new URLSearchParams(location.search).get("v");
if (videoFromUrl) {
  urlInput.value = videoFromUrl;
  handleLoadVideo();
}
