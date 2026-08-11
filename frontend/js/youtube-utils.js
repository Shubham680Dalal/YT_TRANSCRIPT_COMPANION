// Shared by video.html and transcript.html.
// Equivalent to Python's urllib.parse.urlparse(url) + parse_qs(url.query) - we just
// don't have those built in, so we do it by hand with the URL/URLSearchParams classes.

const BARE_VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

/**
 * Extract an 11-char YouTube video ID from a pasted URL, or null if it doesn't look
 * like a YouTube link/ID at all. Handles:
 *   - https://www.youtube.com/watch?v=VIDEOID
 *   - https://youtu.be/VIDEOID
 *   - https://www.youtube.com/embed/VIDEOID
 *   - https://www.youtube.com/shorts/VIDEOID
 *   - a bare 11-character ID pasted directly (no URL at all)
 */
function extractVideoId(input) {
  const trimmed = (input || "").trim();
  if (BARE_VIDEO_ID_RE.test(trimmed)) {
    return trimmed;
  }

  let url;
  try {
    url = new URL(trimmed);
  } catch (err) {
    return null; // not a parseable URL and not a bare ID - give up cleanly
  }

  const host = url.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    const id = url.pathname.slice(1);
    return BARE_VIDEO_ID_RE.test(id) ? id : null;
  }

  if (host === "youtube.com" || host === "m.youtube.com") {
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v");
      return id && BARE_VIDEO_ID_RE.test(id) ? id : null;
    }
    for (const prefix of ["/embed/", "/shorts/"]) {
      if (url.pathname.startsWith(prefix)) {
        const id = url.pathname.slice(prefix.length);
        return BARE_VIDEO_ID_RE.test(id) ? id : null;
      }
    }
  }

  return null;
}
