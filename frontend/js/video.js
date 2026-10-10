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
const fixPlaybackBtn = document.getElementById("fix-playback-btn");
const playerContainer = document.getElementById("player-container");
const recentVideosList = document.getElementById("recent-videos");
const banner = document.getElementById("banner");

let player = null;
let currentVideoId = null;
let currentTitle = "";
let syncChannel = null;
let pendingLoad = null; // {videoId, startSeconds} if a video is loaded before the IFrame API script is ready
let transcriptWindowRef = null; // tracks the popup so a manual close doesn't strand the button

// Filled in from GET /api/config on page load - see loadSyncConfig() below.
let POLL_INTERVAL_MS = 300;
let SEEK_JUMP_THRESHOLD_SECONDS = 1.5;
let PROGRESS_HEARTBEAT_MS = 10000;

const SEEK_STEP_SECONDS = 5;
const RESUME_MIN_SECONDS = 5; // matches progress.min_seconds in config.yaml

let pollTimer = null;
let lastKnownTime = 0;
let lastPollWallClockMs = performance.now();
let lastHeartbeatMs = 0;

// Last position read while the player was actually PLAYING/PAUSED. An unstarted, cued or
// errored player reports 0:00, so that's never trusted for saving or recovery.
let lastGoodPosition = 0;
let resumedFromSeconds = 0;
let autoRetried = false; // one automatic player rebuild per error streak
let awaitingFixReturn = false; // "Fix playback" opened YouTube; rebuild the player once we're back

function showBanner(message, kind) {
  banner.textContent = message;
  banner.className = `banner ${kind}`;
}

function clearBanner() {
  banner.className = "banner";
  banner.textContent = "";
}

function formatTimestamp(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function watchUrl(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

async function loadSyncConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    POLL_INTERVAL_MS = cfg.poll_interval_ms;
    SEEK_JUMP_THRESHOLD_SECONDS = cfg.seek_jump_threshold_seconds;
    PROGRESS_HEARTBEAT_MS = (cfg.progress_heartbeat_seconds || 10) * 1000;
  } catch (err) {
    // Config endpoint down is not fatal - the hardcoded defaults above still work.
    console.warn("Could not load /api/config, using built-in sync defaults.", err);
  }
}

// ---- Watch progress (saved server-side in data/watch_progress.xlsx) ----

async function fetchSavedPosition(videoId) {
  try {
    const res = await fetch(`/api/progress/${videoId}`);
    if (!res.ok) return 0; // 404 = never watched
    const rec = await res.json();
    return rec.status !== "finished" && rec.position >= RESUME_MIN_SECONDS ? rec.position : 0;
  } catch (err) {
    return 0;
  }
}

function sendProgress(videoId, body, { beacon = false } = {}) {
  const url = `/api/progress/${videoId}`;
  const payload = JSON.stringify(body);
  // sendBeacon survives the page being torn down (refresh / tab close); fetch may not.
  if (beacon && navigator.sendBeacon) {
    navigator.sendBeacon(url, new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {}); // a missed heartbeat is harmless - the next one catches up
}

function playerUsable() {
  return player && typeof player.getPlayerState === "function";
}

function reportProgress(state, { beacon = false } = {}) {
  if (!currentVideoId || !playerUsable()) return;
  const ps = player.getPlayerState();
  const trusted = ps === YT.PlayerState.PLAYING || ps === YT.PlayerState.PAUSED;
  let position = trusted ? player.getCurrentTime() : lastGoodPosition;
  if (state === "ended") position = player.getDuration() || position;
  if (!position && state !== "ended") return;

  sendProgress(currentVideoId, {
    position,
    duration: player.getDuration() || 0,
    title: currentTitle || undefined,
    state,
  }, { beacon });
}

let recentVideos = []; // [{video_id, title, position, status, ...}] newest first

async function refreshRecentVideos() {
  try {
    const res = await fetch("/api/progress?limit=20");
    if (!res.ok) return;
    recentVideos = await res.json();
  } catch (err) {
    return;
  }
  recentVideosList.innerHTML = "";
  for (const video of recentVideos) {
    const option = document.createElement("option");
    option.value = watchUrl(video.video_id);
    let label = video.title || video.video_id;
    if (video.status === "finished") label += " · watched";
    else if (video.position >= RESUME_MIN_SECONDS) label += ` · left off at ${formatTimestamp(video.position)}`;
    option.label = label;
    recentVideosList.appendChild(option);
  }
}

// ---- Player lifecycle ----

// YouTube calls this itself once https://www.youtube.com/iframe_api finishes loading.
// Must be a global (window.*) function - this is YouTube's contract, not ours.
window.onYouTubeIframeAPIReady = function () {
  if (pendingLoad) {
    createPlayer(pendingLoad.videoId, pendingLoad.startSeconds);
    pendingLoad = null;
  }
};

function createPlayer(videoId, startSeconds) {
  if (playerUsable() && typeof player.loadVideoById === "function") {
    // Reuse the existing embed instead of re-creating the iframe from scratch.
    player.loadVideoById({ videoId, startSeconds });
    showResumeBanner();
    // onReady only fires once per player, so re-enable here for every later video.
    openTranscriptBtn.disabled = false;
    return;
  }
  player = new YT.Player("player", {
    videoId: videoId,
    playerVars: {
      rel: 0,
      start: Math.floor(startSeconds),
      origin: location.origin, // recommended by YouTube for embeds
      disablekb: 1, // our own shortcuts below handle the keyboard
    },
    events: {
      onReady: onPlayerReady,
      onStateChange: onPlayerStateChange,
      onError: onPlayerError,
    },
  });
}

// Throws the iframe away and builds a fresh one at startSeconds - the in-page
// equivalent of refreshing, re-pasting the link and seeking back by hand.
function recreatePlayer(startSeconds) {
  if (!currentVideoId || typeof YT === "undefined" || !YT.Player) return;
  if (player) {
    try {
      player.destroy();
    } catch (err) {
      // already half-broken - we're replacing it anyway
    }
    player = null;
  }
  playerContainer.innerHTML = '<div id="player"></div>';
  resumedFromSeconds = startSeconds;
  createPlayer(currentVideoId, startSeconds);
}

function bestKnownPosition() {
  if (playerUsable()) {
    const ps = player.getPlayerState();
    if (ps === YT.PlayerState.PLAYING || ps === YT.PlayerState.PAUSED) return player.getCurrentTime();
  }
  return lastGoodPosition;
}

function showResumeBanner() {
  if (resumedFromSeconds >= RESUME_MIN_SECONDS) {
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
    lastGoodPosition = player.getCurrentTime();
    autoRetried = false; // playing fine again - allow another automatic rebuild later
    broadcastSync("playing", lastGoodPosition);
    // The title is only known once the video starts - stored so suggestions read nicely.
    const data = player.getVideoData ? player.getVideoData() : null;
    if (data && data.title) currentTitle = data.title;
  } else if (event.data === YT.PlayerState.PAUSED) {
    lastGoodPosition = player.getCurrentTime();
    broadcastSync("paused", lastGoodPosition);
    reportProgress("paused");
  } else if (event.data === YT.PlayerState.ENDED) {
    broadcastSync("paused", player.getCurrentTime());
    reportProgress("ended"); // marks it finished - next time it starts from 0:00
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
const PERMANENT_PLAYER_ERRORS = new Set([2, 100]); // retrying can't fix these

function onPlayerError(event) {
  if (!autoRetried && !PERMANENT_PLAYER_ERRORS.has(event.data)) {
    autoRetried = true;
    showBanner("The player hit an error - reloading it where you were...", "info");
    setTimeout(() => recreatePlayer(lastGoodPosition), 1000);
    return;
  }
  const base = PLAYER_ERROR_MESSAGES[event.data] || "Something went wrong loading this video.";
  showBanner(`${base} (YouTube error ${event.data}) - try "Fix playback" above.`, "error");
}

// Opening youtube.com in a tab is what fixes a player that broke after a long session
// (it refreshes YouTube's own session in the browser). This button does that, then
// rebuilds the player at the same spot as soon as you come back to this window.
fixPlaybackBtn.addEventListener("click", () => {
  lastGoodPosition = bestKnownPosition();
  awaitingFixReturn = true;
  window.open("https://www.youtube.com/", "_blank", "noopener");
  showBanner("Opened YouTube in a new tab - come back here and the player reloads where you were.", "info");
});

function finishFixPlayback() {
  if (!awaitingFixReturn || document.visibilityState !== "visible") return;
  awaitingFixReturn = false;
  recreatePlayer(lastGoodPosition);
}
window.addEventListener("focus", finishFixPlayback);
document.addEventListener("visibilitychange", finishFixPlayback);

// ---- Sync with the transcript window ----

function broadcastSync(state, currentTime) {
  if (!syncChannel) return;
  syncChannel.postMessage({
    type: "sync",
    videoId: currentVideoId,
    state: state,
    currentTime: currentTime,
    playbackRate: playerUsable() ? player.getPlaybackRate() : 1,
  });
}

function openSyncChannel(videoId) {
  if (syncChannel) syncChannel.close();
  syncChannel = new BroadcastChannel(`yt-sync-${videoId}`);
  // The transcript window forwards its keyboard shortcuts here.
  syncChannel.onmessage = (event) => {
    if (event.data && event.data.type === "control") runShortcut(event.data.action);
  };
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  lastKnownTime = player.getCurrentTime();
  lastPollWallClockMs = performance.now();

  pollTimer = setInterval(() => {
    if (!playerUsable() || typeof player.getCurrentTime !== "function") return;
    if (player.getPlayerState() !== YT.PlayerState.PLAYING) return;

    const now = player.getCurrentTime();
    lastGoodPosition = now;
    const wallClockElapsedSec = (performance.now() - lastPollWallClockMs) / 1000;
    // Expected drift accounts for playback rate so 2x/4x speed is never mistaken for a seek.
    const expectedDrift = wallClockElapsedSec * player.getPlaybackRate();
    const actualDelta = Math.abs(now - lastKnownTime);

    // Whether or not this tick looks like a seek, broadcast a heartbeat anyway - this
    // is what lets a freshly (re)opened transcript window resync within one poll
    // interval, with no separate handshake needed.
    broadcastSync("playing", now);

    if (performance.now() - lastHeartbeatMs >= PROGRESS_HEARTBEAT_MS) {
      reportProgress("playing");
      lastHeartbeatMs = performance.now();
    }

    if (actualDelta > expectedDrift + SEEK_JUMP_THRESHOLD_SECONDS) {
      console.debug("Seek detected", { from: lastKnownTime, to: now });
    }

    lastKnownTime = now;
    lastPollWallClockMs = performance.now();
  }, POLL_INTERVAL_MS);
}

// ---- Keyboard shortcuts ----
// Space: play / pause · ← / V: back 5s · → / B: forward 5s

function shortcutFor(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case " ":
    case "Spacebar":
      return "toggle";
    case "ArrowLeft":
    case "v":
    case "V":
      return "back";
    case "ArrowRight":
    case "b":
    case "B":
      return "forward";
    default:
      return null;
  }
}

function runShortcut(action) {
  if (!playerUsable() || typeof player.seekTo !== "function") return;
  const now = player.getCurrentTime();
  const duration = player.getDuration() || Infinity;
  const isPlaying = player.getPlayerState() === YT.PlayerState.PLAYING;

  if (action === "toggle") {
    if (isPlaying) player.pauseVideo();
    else player.playVideo();
    return;
  }

  const delta = action === "back" ? -SEEK_STEP_SECONDS : SEEK_STEP_SECONDS;
  const target = Math.min(Math.max(0, now + delta), duration);
  player.seekTo(target, true);
  broadcastSync(isPlaying ? "playing" : "paused", target);
}

function isTypingTarget(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}

document.addEventListener("keydown", (e) => {
  if (isTypingTarget(e.target)) return;
  const action = shortcutFor(e);
  if (!action) return;
  e.preventDefault(); // stop Space from scrolling the page or "clicking" a focused button
  runShortcut(action);
});
document.addEventListener("keyup", (e) => {
  if (!isTypingTarget(e.target) && shortcutFor(e) === "toggle") e.preventDefault();
});

// Clicking the video moves keyboard focus into YouTube's iframe, where this page can't
// hear key presses. Hand focus straight back - the click itself still reaches the player.
window.addEventListener("blur", () => {
  setTimeout(() => {
    const el = document.activeElement;
    if (el && el.tagName === "IFRAME") {
      el.blur();
      window.focus();
    }
  }, 0);
});

// ---- Loading videos ----

async function loadVideo(videoId) {
  clearBanner();
  // Leave the link box, otherwise Space / V / B get typed into it instead of
  // reaching the shortcuts (it has autofocus, so this matters even on refresh).
  urlInput.blur();

  // Save the outgoing video's spot before switching away from it.
  if (currentVideoId && currentVideoId !== videoId) reportProgress("closed");

  currentVideoId = videoId;
  currentTitle = "";
  autoRetried = false;
  openSyncChannel(videoId);

  // Put the video in the page URL so a refresh reloads it (and resumes) automatically.
  const pageUrl = new URL(location.href);
  pageUrl.searchParams.set("v", videoId);
  history.replaceState(null, "", pageUrl);
  openTranscriptBtn.disabled = true; // re-enabled once the new video loads
  fixPlaybackBtn.hidden = false;

  const startSeconds = await fetchSavedPosition(videoId);
  if (videoId !== currentVideoId) return; // another video was picked while we waited
  resumedFromSeconds = startSeconds;
  lastGoodPosition = startSeconds;

  if (typeof YT !== "undefined" && YT.Player) {
    createPlayer(videoId, startSeconds);
  } else {
    // IFrame API script hasn't finished loading yet - onYouTubeIframeAPIReady will
    // pick this up once it fires.
    pendingLoad = { videoId, startSeconds };
  }

  // Record the visit so it shows up in suggestions straight away. Position 0 never
  // overwrites a saved spot (see progress_service.update).
  sendProgress(videoId, { position: 0, state: "opened" });
  refreshRecentVideos();
}

function handleLoadVideo() {
  const videoId = extractVideoId(urlInput.value);
  if (!videoId) {
    showBanner("Couldn't recognize that as a YouTube URL or video ID.", "error");
    return;
  }
  loadVideo(videoId);
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
  if (e.key === "Escape") urlInput.blur(); // back to shortcuts without loading anything
});

// Picking a suggestion from the dropdown loads it straight away - no extra click needed.
// Browsers report a datalist pick as an input event without a normal typing inputType.
urlInput.addEventListener("input", (e) => {
  if (e.inputType && e.inputType !== "insertReplacementText") return;
  const picked = recentVideos.some((v) => watchUrl(v.video_id) === urlInput.value);
  if (picked) handleLoadVideo();
});

// Refresh the "left off at" labels each time the box is focused.
urlInput.addEventListener("focus", refreshRecentVideos);
refreshRecentVideos();

// Refresh / tab close: save the exact spot, not just the last heartbeat.
window.addEventListener("pagehide", () => reportProgress("closed", { beacon: true }));

loadSyncConfig();

const videoFromUrl = new URLSearchParams(location.search).get("v");
if (videoFromUrl) {
  urlInput.value = videoFromUrl;
  handleLoadVideo();
} else {
  // Only grab the link box when there's nothing loaded - an HTML autofocus attribute
  // would also steal focus on refresh and swallow the shortcuts.
  urlInput.focus();
}
