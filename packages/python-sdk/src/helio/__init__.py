"""Helio Python SDK — thin client for the MCP governance proxy."""

from ._version import __version__
from .client import HelioClient, HelioError
from .context import HelioContext
from .types import (
    CompletedTool,
    EvidenceEntry,
    EvidenceStateReport,
    SessionState,
)

__all__ = [
    "__version__",
    "HelioClient",
    "HelioContext",
    "HelioError",
    "CompletedTool",
    "EvidenceEntry",
    "EvidenceStateReport",
    "SessionState",
]
