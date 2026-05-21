"""Shared type definitions for the Helio Python SDK."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True)
class EvidenceEntry:
    """A single evidence record from the proxy's session store."""

    evidence_key: str
    data: Any
    tool_name: str
    timestamp: str
    expires_at: float  # epoch milliseconds


@dataclass(frozen=True)
class CompletedTool:
    """A tool invocation recorded by the proxy."""

    tool_name: str
    timestamp: str
    succeeded: bool


@dataclass(frozen=True)
class SessionState:
    """Full session state as reported by the proxy sideband API."""

    session_id: str
    evidence: dict[str, EvidenceEntry] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    completed_tools: list[CompletedTool] = field(default_factory=list)


@dataclass(frozen=True)
class EvidenceStateReport:
    """Result of get_evidence_state() with local requirement comparison.

    Extends session state with satisfied/missing lists computed by
    comparing the proxy's evidence against locally declared requirements.
    """

    session_id: str
    evidence: dict[str, EvidenceEntry] = field(default_factory=dict)
    context: dict[str, Any] = field(default_factory=dict)
    completed_tools: list[CompletedTool] = field(default_factory=list)
    satisfied: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
