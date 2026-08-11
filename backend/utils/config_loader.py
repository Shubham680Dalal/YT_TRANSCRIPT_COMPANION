import yaml
from pathlib import Path

_config: dict | None = None


def get_config() -> dict:
    global _config
    if _config is None:
        config_path = Path(__file__).parent.parent.parent / "config.yaml"
        with open(config_path, "r") as f:
            _config = yaml.safe_load(f)
    return _config
