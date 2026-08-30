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

function createPlayer(videoId) {
  if (player) {
    // Reuse the existing embed instead of re-creating the iframe from scratch.
    player.loadVideoById(videoId);
  } else {
    player = new YT.Player("player", {
      videoId: videoId,
      playerVars: { rel: 0 },
      events: {
        onReady: onPlayerReady,
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  }
}

function onPlayerReady() {
  clearBanner();
  openTranscriptBtn.disabled = false;
  startPolling();
}

function onPlayerStateChange(event) {
  // YT.PlayerState: ENDED=0, PLAYING=1, PAUSED=2, BUFFERING=3, CUED=5
  if (event.data === YT.PlayerState.PLAYING) {
    broadcastSync("playing", player.getCurrentTime());
  } else if (event.data === YT.PlayerState.PAUSED) {
    broadcastSync("paused", player.getCurrentTime());
  } else if (event.data === YT.PlayerState.ENDED) {
    broadcastSync("paused", player.getCurrentTime());
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

  currentVideoId = videoId;
  syncChannel = new BroadcastChannel(`yt-sync-${videoId}`);
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

loadSyncConfig();
