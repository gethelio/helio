"""High-level context wrapper for the Helio SDK."""

from __future__ import annotations

import threading
from typing import Any

from .client import HelioClient
from .types import EvidenceStateReport


class HelioContext:
    """Primary public API for the Helio Python SDK.

    Wraps a :class:`HelioClient` and adds local requirement tracking.
    The SDK never makes governance decisions — it only reports evidence
    and context to the proxy via the sideband API.
    """

    def __init__(
        self,
        proxy_url: str = "http://127.0.0.1:3200",
        session_id: str | None = None,
        *,
        timeout: float = 5.0,
    ) -> None:
        self._client = HelioClient(proxy_url, session_id, timeout=timeout)
        self._required_keys: set[str] = set()
        # Guards mutation of and reads from _required_keys. CPython's GIL
        # hides most set races today, but the SDK is also expected to work
        # under PyPy and any future no-GIL interpreters, so we serialize
        # explicitly.
        self._lock = threading.Lock()

    @property
    def client(self) -> HelioClient:
        """Access the underlying HelioClient for advanced use."""
        return self._client

    @property
    def session_id(self) -> str:
        """The session ID used for all sideband API calls."""
        return self._client.session_id

    def mark_evidence(
        self,
        tool_name: str,
        evidence_key: str,
        data: Any,
        ttl: int = 300,
    ) -> None:
        """Mark tool output as evidence via the sideband API.

        Args:
            tool_name: The MCP tool that produced this evidence.
            evidence_key: Evidence key (e.g. ``"orders.lookup"``).
            data: Arbitrary data to attach as evidence.
            ttl: Time-to-live in seconds (default 300).

        Raises:
            HelioError: If the proxy is unreachable or returns an error.
        """
        self._client.mark_evidence(tool_name, evidence_key, data, ttl=ttl)

    def require_evidence(self, keys: list[str] | str) -> None:
        """Declare evidence keys that this context requires.

        Purely informational — stored locally on this instance. Used by
        :meth:`get_evidence_state` to compute satisfied/missing lists.
        Does **not** raise exceptions or make governance decisions.

        Args:
            keys: A single key or list of evidence keys to require.
        """
        if isinstance(keys, str):
            keys = [keys]
        with self._lock:
            self._required_keys.update(keys)

    def set(self, key: str, value: Any) -> None:
        """Set a session context value via the sideband API.

        Args:
            key: Context key.
            value: Any JSON-serializable value.

        Raises:
            HelioError: If the proxy is unreachable or returns an error.
        """
        self._client.set_context(key, value)

    def get_evidence_state(self) -> EvidenceStateReport:
        """Fetch session state from the proxy and compare against local requirements.

        Returns:
            An :class:`EvidenceStateReport` with all fields from the
            proxy's session state plus ``satisfied`` and ``missing`` lists
            computed by comparing the proxy's evidence against keys declared
            via :meth:`require_evidence`. Makes no governance decisions —
            the lists are purely informational.

        Raises:
            HelioError: If the proxy is unreachable or returns an error.
        """
        # Snapshot the required keys under the lock, then release before the
        # network call so a slow sideband fetch never blocks concurrent
        # `require_evidence` callers.
        with self._lock:
            required_snapshot = sorted(self._required_keys)

        state = self._client.get_session_state()

        satisfied: list[str] = []
        missing: list[str] = []
        for key in required_snapshot:
            (satisfied if key in state.evidence else missing).append(key)

        return EvidenceStateReport(
            session_id=state.session_id,
            evidence=state.evidence,
            context=state.context,
            completed_tools=state.completed_tools,
            satisfied=satisfied,
            missing=missing,
        )

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> HelioContext:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()
