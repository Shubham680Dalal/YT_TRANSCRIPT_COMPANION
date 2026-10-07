from fpdf import FPDF

# Raw cues are ~7-8 words each; merge them into readable paragraphs, each prefixed
# with the timestamp it starts at.
PARAGRAPH_WORDS = 60

# fpdf2's built-in fonts only cover Latin-1, so map the usual caption punctuation to
# plain equivalents; anything else outside Latin-1 becomes "?".
_REPLACEMENTS = str.maketrans({
    "‘": "'", "’": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", "…": "...", " ": " ",
    "♪": "~", "♫": "~", "\n": " ",
})


def _to_latin1(text: str) -> str:
    return text.translate(_REPLACEMENTS).encode("latin-1", "replace").decode("latin-1")


def _format_timestamp(seconds: float) -> str:
    s = int(seconds)
    h, m, sec = s // 3600, (s % 3600) // 60, s % 60
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"


def _group_into_paragraphs(cues: list[dict]) -> list[tuple[float, str]]:
    paragraphs = []
    start, words = None, []
    for cue in cues:
        text = cue["text"].strip()
        if not text:
            continue
        if start is None:
            start = cue["start"]
        words.extend(text.split())
        if len(words) >= PARAGRAPH_WORDS:
            paragraphs.append((start, " ".join(words)))
            start, words = None, []
    if words:
        paragraphs.append((start, " ".join(words)))
    return paragraphs


def build_transcript_pdf(video_id: str, language: str, cues: list[dict], title: str | None = None) -> bytes:
    pdf = FPDF(format="A4")
    pdf.set_auto_page_break(auto=True, margin=15)
    pdf.set_title(_to_latin1(title or f"Transcript {video_id}"))
    pdf.add_page()

    pdf.set_font("Helvetica", "B", 16)
    pdf.multi_cell(0, 8, _to_latin1(title or "YouTube Transcript"), new_x="LMARGIN", new_y="NEXT")

    video_url = f"https://www.youtube.com/watch?v={video_id}"
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(90, 90, 90)
    pdf.cell(0, 5, f"{video_url}  |  language: {language}", link=video_url, new_x="LMARGIN", new_y="NEXT")
    pdf.ln(4)

    for start, text in _group_into_paragraphs(cues):
        pdf.set_font("Helvetica", "B", 9)
        pdf.set_text_color(41, 74, 115)
        pdf.cell(0, 5, _format_timestamp(start), link=f"{video_url}&t={int(start)}s", new_x="LMARGIN", new_y="NEXT")
        pdf.set_font("Helvetica", "", 11)
        pdf.set_text_color(20, 20, 20)
        pdf.multi_cell(0, 6, _to_latin1(text), new_x="LMARGIN", new_y="NEXT")
        pdf.ln(2)

    return bytes(pdf.output())
