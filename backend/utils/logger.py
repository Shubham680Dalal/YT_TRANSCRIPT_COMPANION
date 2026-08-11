import os
import logging
import structlog
from backend.utils.config_loader import get_config


def _configure_structlog() -> None:
    cfg = get_config()
    is_dev = os.getenv(cfg["logging"]["env_var"]) == cfg["logging"]["dev_value"]

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_log_level,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if is_dev:
        renderer = structlog.dev.ConsoleRenderer()
    else:
        renderer = structlog.processors.JSONRenderer()

    structlog.configure(
        processors=shared_processors + [renderer],
        wrapper_class=structlog.make_filtering_bound_logger(
            getattr(logging, cfg["logging"]["level"], logging.INFO)
        ),
        context_class=dict,
        logger_factory=structlog.PrintLoggerFactory(),
        cache_logger_on_first_use=True,
    )


_configured = False


def get_logger(name: str) -> structlog.BoundLogger:
    global _configured
    if not _configured:
        _configure_structlog()
        _configured = True
    return structlog.get_logger(name)
