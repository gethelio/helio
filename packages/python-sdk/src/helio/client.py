"""Low-level HTTP client for the Helio sideband API."""

from __future__ import annotations

import os
import uuid
from typing import Any, Callable

import httpx

from .types import CompletedTool, EvidenceEntry, SessionState


class HelioError(Exception):
    """Base exception for all Helio SDK errors.

    Wraps low-level HTTP errors with actionable context: which method
    was called, which endpoint, and what went wrong.
    """

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class HelioClient:
    """Thin HTTP client for the Helio proxy sideband API.

    Communicates with the proxy's sideband HTTP server to report evidence
    and context. The client never makes governance decisions — that is
    always the proxy's job.
    """

    def __init__(
        self,
        proxy_url: str = "http://127.0.0.1:3200",
        session_id: str | None = None,
        *,
        timeout: float = 5.0,
    ) -> None:
        self._proxy_url = proxy_url.rstrip("/")
        self._session_id = session_id or uuid.uuid4().hex

        # Read HELIO_SDK_TOKEN once at construction time and bake it into
        # the httpx client's default headers so it is attached to every
        # request. The proxy prints this token to stderr on `helio start`
        # when `sdk.enabled` is true; operators pass it to their SDK
        # process via the environment. An empty string is treated as
        # "unset" so a malformed Bearer header is never sent (open-mode
        # local dev and operators who have explicitly opted out of the
        # token both keep working without any Authorization header).
        #
        # The token is bound at construction — rotating it after the
        # client is built does not affect the already-built httpx.Client.
        # Operators rotate by restarting the SDK process, matching the
        # proxy's per-boot rotation model.
        token = os.environ.get("HELIO_SDK_TOKEN")
        headers: dict[str, str] = {}
        if token:
            headers["Authorization"] = f"Bearer {token}"

        self._http = httpx.Client(
            base_url=self._proxy_url,
            timeout=timeout,
            headers=headers,
        )

    @property
    def session_id(self) -> str:
        """The session ID used for all sideband API calls."""
        return self._session_id

    @property
    def proxy_url(self) -> str:
        """The base URL of the proxy sideband API."""
        return self._proxy_url

    def _request_with_normalized_errors(
        self,
        *,
        operation: str,
        send: Callable[[], httpx.Response],
        response_details_formatter: Callable[[httpx.Response], str | None] | None = None,
    ) -> httpx.Response:
        """Send a sideband request and normalize transport/status failures."""
        try:
            response = send()
            response.raise_for_status()
            return response
        except httpx.ConnectError as exc:
            raise HelioError(f'Cannot connect to proxy at {self._proxy_url}') from exc
        except httpx.TimeoutException as exc:
            raise HelioError(f'Proxy request timed out: {operation}') from exc
        except httpx.HTTPStatusError as exc:
            message = f'{operation} failed: HTTP {exc.response.status_code}'
            if response_details_formatter is not None:
                details = response_details_formatter(exc.response)
                if details:
                    message = f'{message} ({details})'
            raise HelioError(
                message,
                status_code=exc.response.status_code,
            ) from exc

    def mark_evidence(
        self,
        tool_name: str,
        evidence_key: str,
        data: Any,
        ttl: int = 300,
    ) -> None:
        """Report evidence from a tool output. POST /evidence.

        Raises:
            HelioError: If the payload cannot be serialized as JSON, the proxy is
                unreachable, or the proxy returns an error.
        """
        try:
            self._request_with_normalized_errors(
                operation='POST /evidence',
                send=lambda: self._http.post(
                    '/evidence',
                    json={
                        'session_id': self._session_id,
                        'tool_name': tool_name,
                        'evidence_key': evidence_key,
                        'evidence_data': data,
                        'ttl_seconds': ttl,
                    },
                ),
                response_details_formatter=_format_evidence_error_details,
            )
        except (TypeError, ValueError) as exc:
            raise HelioError(
                f'Failed to serialize POST /evidence payload as JSON: {exc}',
            ) from exc

    def set_context(self, key: str, value: Any) -> None:
        """Set arbitrary session context. POST /context.

        Raises:
            HelioError: If the payload cannot be serialized as JSON, the proxy is
                unreachable, or the proxy returns an error.
        """
        try:
            self._request_with_normalized_errors(
                operation='POST /context',
                send=lambda: self._http.post(
                    '/context',
                    json={
                        'session_id': self._session_id,
                        'key': key,
                        'value': value,
                    },
                ),
            )
        except (TypeError, ValueError) as exc:
            raise HelioError(
                f'Failed to serialize POST /context payload as JSON: {exc}',
            ) from exc

    def get_session_state(self) -> SessionState:
        """Fetch combined session state. GET /session/:id/state.

        Raises:
            HelioError: If the proxy is unreachable or returns an error.
        """
        try:
            resp = self._request_with_normalized_errors(
                operation=f'GET /session/{self._session_id}/state',
                send=lambda: self._http.get(f'/session/{self._session_id}/state'),
            )
            return _parse_session_state(resp.json())
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise HelioError(
                f'GET /session/{self._session_id}/state returned malformed response payload',
                status_code=200,
            ) from exc

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._http.close()

    def __enter__(self) -> HelioClient:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


def _parse_session_state(raw: dict[str, Any]) -> SessionState:
    """Parse the JSON response from GET /session/:id/state.

    The proxy emits snake_case field names directly, so each entry can be
    splatted into its dataclass constructor without a key-rename layer.
    """
    if not isinstance(raw, dict):
        raise ValueError("session state must be an object")

    session_id = raw.get("session_id")
    if not isinstance(session_id, str):
        raise ValueError("session_id must be a string")

    evidence_raw = raw.get("evidence", {})
    if not isinstance(evidence_raw, dict):
        raise ValueError("evidence must be an object")

    context_raw = raw.get("context", {})
    if not isinstance(context_raw, dict):
        raise ValueError("context must be an object")

    completed_raw = raw.get("completed_tools", [])
    if not isinstance(completed_raw, list):
        raise ValueError("completed_tools must be a list")

    evidence: dict[str, EvidenceEntry] = {}
    for key, entry in evidence_raw.items():
        if not isinstance(key, str):
            raise ValueError("evidence keys must be strings")
        if not isinstance(entry, dict):
            raise ValueError("evidence entries must be objects")
        evidence[key] = EvidenceEntry(**entry)

    completed: list[CompletedTool] = []
    for tool in completed_raw:
        if not isinstance(tool, dict):
            raise ValueError("completed_tools entries must be objects")
        completed.append(CompletedTool(**tool))

    return SessionState(
        session_id=session_id,
        evidence=evidence,
        context=context_raw,
        completed_tools=completed,
    )


def _format_evidence_error_details(response: httpx.Response) -> str | None:
    """Extract structured details from failed POST /evidence responses."""
    try:
        raw = response.json()
    except ValueError:
        return None

    if not isinstance(raw, dict):
        return None

    code = raw.get("code")
    if not isinstance(code, str):
        return None

    parts: list[str] = [f"code={code}"]

    key = raw.get("key")
    if isinstance(key, str):
        parts.append(f'key="{key}"')

    allowed_keys = raw.get("allowed_keys")
    allowed_key_count = raw.get("allowed_key_count")
    truncated = raw.get("truncated")
    if isinstance(allowed_keys, list):
        shown = [item for item in allowed_keys if isinstance(item, str)]
        if shown:
            if isinstance(allowed_key_count, int) and isinstance(truncated, bool) and truncated:
                parts.append(
                    f"allowed_keys={shown} (showing {len(shown)} of {allowed_key_count})"
                )
            else:
                parts.append(f"allowed_keys={shown}")

    return ", ".join(parts)
