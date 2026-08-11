// Window B: fetches the transcript once, then follows Window A's playback via
// BroadcastChannel - a same-origin pub/sub channel built into the browser (think of it
// like a local, in-memory queue that any tab/window on this origin can publish to or
// subscribe to, no server involved).

const bannerEl = document.getElementById("banner");
const emptyStateEl = document.getElementById("empty-state");
const listEl = document.getElementById("transcript-list");

let cues = []; // [{text, start, duration}, ...] sorted by start (guaranteed by the API)
let cueElements = [];
let activeIndex = -1;

function showBanner(message, kind) {
  bannerEl.textContent = message;
  bannerEl.className = `banner ${kind}`;
}

function showEmptyState(message) {
  emptyStateEl.textContent = message;
  emptyStateEl.style.display = "block";
}

function hideEmptyState() {
  emptyStateEl.style.display = "none";
}

function renderCues() {
  listEl.innerHTML = "";
  cueElements = cues.map((cue) => {
    const el = document.createElement("div");
    el.className = "cue";
    el.textContent = cue.text;
    listEl.appendChild(el);
    return el;
  });
}

// cues are sorted by start time, so binary search finds the active cue in O(log n)
// instead of rescanning the whole transcript on every ~300ms sync message.
function findActiveIndex(currentTime) {
  let lo = 0;
  let hi = cues.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= currentTime) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function updateHighlight(currentTime) {
  const newIndex = findActiveIndex(currentTime);
  if (newIndex === activeIndex) return; // gate scrolling/class swaps on index change only

  if (activeIndex >= 0 && cueElements[activeIndex]) {
    cueElements[activeIndex].classList.remove("active");
  }
  if (newIndex >= 0 && cueElements[newIndex]) {
    cueElements[newIndex].classList.add("active");
    cueElements[newIndex].scrollIntoView({ block: "center", behavior: "smooth" });
  }
  activeIndex = newIndex;
}

async function loadTranscript(videoId) {
  try {
    const res = await fetch(`/api/transcript/${videoId}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      showBanner(body.detail || "Could not load transcript for this video.", "error");
      return;
    }
    const data = await res.json();
    cues = data.cues;
    renderCues();
    showEmptyState("Waiting for the video window to start playing...");
  } catch (err) {
    showBanner("Could not reach the local server to fetch the transcript.", "error");
  }
}

function connectSync(videoId) {
  const channel = new BroadcastChannel(`yt-sync-${videoId}`);
  channel.onmessage = (event) => {
    hideEmptyState();
    updateHighlight(event.data.currentTime);
  };
}

function init() {
  const params = new URLSearchParams(location.search);
  const videoId = params.get("video_id");

  if (!videoId) {
    showEmptyState("Open this from the video window's \"Open Transcript Window\" button.");
    return;
  }

  showEmptyState("Loading transcript...");
  loadTranscript(videoId);
  connectSync(videoId);
}

init();
