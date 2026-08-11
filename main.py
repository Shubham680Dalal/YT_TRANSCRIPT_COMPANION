import uvicorn

from backend.app import create_app
from backend.utils.config_loader import get_config
from backend.utils.logger import get_logger

app = create_app()

if __name__ == "__main__":
    log = get_logger(__name__)
    cfg = get_config()
    host = cfg["server"]["host"]
    port = cfg["server"]["port"]
    log.info("starting_server", host=host, port=port)
    uvicorn.run("main:app", host=host, port=port, reload=True)
