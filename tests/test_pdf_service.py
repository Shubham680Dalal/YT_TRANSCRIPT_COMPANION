from backend.services import pdf_service


def _cues(texts):
    return [{"text": t, "start": float(i * 3), "duration": 3.0} for i, t in enumerate(texts)]


def test_build_transcript_pdf_returns_pdf_bytes():
    pdf = pdf_service.build_transcript_pdf("aircAruvnKk", "en", _cues(["hello there", "general kenobi"]), "A Title")

    assert pdf.startswith(b"%PDF")


def test_non_latin1_text_does_not_crash():
    cues = _cues(["♪ music ♪", "it’s “quoted” — ok", "नमस्ते \U0001F600"])

    pdf = pdf_service.build_transcript_pdf("aircAruvnKk", "en", cues, "Title — with dash")

    assert pdf.startswith(b"%PDF")


def test_empty_transcript_still_builds():
    assert pdf_service.build_transcript_pdf("aircAruvnKk", "en", []).startswith(b"%PDF")


def test_group_into_paragraphs_merges_cues_and_keeps_first_start():
    cues = _cues(["one two three"] * 30)  # 90 words -> one full paragraph + a remainder

    paragraphs = pdf_service._group_into_paragraphs(cues)

    assert len(paragraphs) == 2
    assert paragraphs[0][0] == 0.0
    assert len(paragraphs[0][1].split()) == pdf_service.PARAGRAPH_WORDS
    assert paragraphs[1][0] == 60.0  # starts at the 21st cue


def test_format_timestamp():
    assert pdf_service._format_timestamp(75) == "1:15"
    assert pdf_service._format_timestamp(3725) == "1:02:05"
