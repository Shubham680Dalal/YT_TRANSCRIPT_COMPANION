from backend.utils.video_id_validator import is_valid_video_id


def test_accepts_valid_11_char_id():
    assert is_valid_video_id("aircAruvnKk")


def test_accepts_ids_with_underscore_and_dash():
    assert is_valid_video_id("a-b_c-d_e12")


def test_rejects_wrong_length():
    assert not is_valid_video_id("short")
    assert not is_valid_video_id("way-too-long-id")


def test_rejects_invalid_characters():
    assert not is_valid_video_id("abc!@#$%^&*")


def test_rejects_empty_string():
    assert not is_valid_video_id("")
