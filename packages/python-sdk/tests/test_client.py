"""Tests for HelioClient — low-level HTTP client."""

from __future__ import annotations

import json

import pytest
import respx

from helio import HelioClient, HelioError


@pytest.fixture
def clear_sdk_token(monkeypatch):
    """Clear HELIO_SDK_TOKEN from the test environment.

    The parent shell may have it set for local development; these tests
    verify the no-token branch explicitly, so we strip it before any
    HelioClient is constructed.
    """
    monkeypatch.delenv("HELIO_SDK_TOKEN", raising=False)


class TestConstructor:
    def test_default_session_id_is_uuid_hex(self):
        client = HelioClient()
        assert len(client.session_id) == 32
        int(client.session_id, 16)  # must be valid hex
        client.close()

    def test_explicit_session_id(self):
        client = HelioClient(session_id="my-session")
        assert client.session_id == "my-session"
        client.close()

    def test_default_proxy_url(self):
        client = HelioClient()
        assert client.proxy_url == "http://127.0.0.1:3200"
        client.close()

    def test_trailing_slash_stripped(self):
        client = HelioClient(proxy_url="http://localhost:3200/")
        assert client.proxy_url == "http://localhost:3200"
        client.close()


class TestMarkEvidence:
    def test_sends_correct_payload(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("get_order", "orders.lookup", {"orderId": 42}, ttl=60)

        request = mock_api.calls[0].request
        body = json.loads(request.content)
        assert body == {
            "session_id": "s1",
            "tool_name": "get_order",
            "evidence_key": "orders.lookup",
            "evidence_data": {"orderId": 42},
            "ttl_seconds": 60,
        }

    def test_default_ttl_is_300(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("tool", "key", "data")

        body = json.loads(mock_api.calls[0].request.content)
        assert body["ttl_seconds"] == 300

    def test_raises_helio_error_on_non_serializable_payload(
        self,
        mock_api: respx.MockRouter,
    ):
        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.mark_evidence("tool", "key", {"bad": object()})

        assert "Failed to serialize POST /evidence payload as JSON" in str(exc_info.value)
        assert isinstance(exc_info.value.__cause__, TypeError)
        assert len(mock_api.calls) == 0

    def test_raises_helio_error_on_400(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(400, json={"error": "Validation error"})

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.mark_evidence("tool", "key", "data")
            assert exc_info.value.status_code == 400
            assert "POST /evidence" in str(exc_info.value)

    def test_surfaces_allowlist_rejection_details(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(
            400,
            json={
                "error": "Evidence key is not in policy allowlist",
                "code": "evidence_key_not_in_policy_allowlist",
                "key": "weather.lookup",
                "allowed_keys": ["orders.lookup", "customer.lookup"],
                "allowed_key_count": 25,
                "truncated": True,
            },
        )

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.mark_evidence("tool", "weather.lookup", "data")

            message = str(exc_info.value)
            assert "code=evidence_key_not_in_policy_allowlist" in message
            assert 'key="weather.lookup"' in message
            assert "allowed_keys=['orders.lookup', 'customer.lookup'] (showing 2 of 25)" in message


class TestSetContext:
    def test_sends_correct_payload(self, mock_api: respx.MockRouter):
        mock_api.post("/context").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.set_context("agent_id", "support-bot")

        body = json.loads(mock_api.calls[0].request.content)
        assert body == {
            "session_id": "s1",
            "key": "agent_id",
            "value": "support-bot",
        }

    def test_raises_helio_error_on_500(self, mock_api: respx.MockRouter):
        mock_api.post("/context").respond(500, json={"error": "Internal error"})

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.set_context("key", "value")
            assert exc_info.value.status_code == 500
            assert "POST /context" in str(exc_info.value)

    def test_raises_helio_error_on_non_serializable_payload(
        self,
        mock_api: respx.MockRouter,
    ):
        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.set_context("key", {"bad": object()})

        assert "Failed to serialize POST /context payload as JSON" in str(exc_info.value)
        assert isinstance(exc_info.value.__cause__, TypeError)
        assert len(mock_api.calls) == 0


class TestGetSessionState:
    FULL_STATE = {
        "session_id": "s1",
        "evidence": {
            "orders.lookup": {
                "evidence_key": "orders.lookup",
                "data": {"orderId": 42},
                "tool_name": "get_order",
                "timestamp": "2026-03-31T10:00:00.000Z",
                "expires_at": 1743415500000,
            }
        },
        "context": {"agent_id": "bot"},
        "completed_tools": [
            {
                "tool_name": "get_order",
                "timestamp": "2026-03-31T10:00:00.000Z",
                "succeeded": True,
            }
        ],
    }

    def test_parses_full_response(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=self.FULL_STATE)

        with HelioClient(session_id="s1") as client:
            state = client.get_session_state()

        assert state.session_id == "s1"
        assert "orders.lookup" in state.evidence
        entry = state.evidence["orders.lookup"]
        assert entry.data == {"orderId": 42}
        assert entry.tool_name == "get_order"
        assert state.context == {"agent_id": "bot"}
        assert len(state.completed_tools) == 1
        assert state.completed_tools[0].tool_name == "get_order"
        assert state.completed_tools[0].succeeded is True

    def test_handles_empty_session(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(
            200,
            json={
                "session_id": "s1",
                "evidence": {},
                "context": {},
                "completed_tools": [],
            },
        )

        with HelioClient(session_id="s1") as client:
            state = client.get_session_state()

        assert state.evidence == {}
        assert state.context == {}
        assert state.completed_tools == []


class TestGetSessionStateErrors:
    def test_raises_helio_error_on_404(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(404, json={"error": "Not found"})

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.get_session_state()
            assert exc_info.value.status_code == 404
            assert "GET /session" in str(exc_info.value)

    def test_raises_helio_error_on_malformed_json_payload(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, text="not-json")

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.get_session_state()
            assert exc_info.value.status_code == 200
            assert "malformed response payload" in str(exc_info.value)

    def test_raises_helio_error_on_invalid_session_state_shape(
        self,
        mock_api: respx.MockRouter,
    ):
        mock_api.get("/session/s1/state").respond(
            200,
            json={
                "evidence": {},  # missing required session_id key
                "context": {},
                "completed_tools": [],
            },
        )

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.get_session_state()
            assert exc_info.value.status_code == 200
            assert "malformed response payload" in str(exc_info.value)

    @pytest.mark.parametrize(
        "payload",
        [
            {
                "session_id": "s1",
                "evidence": [],
                "context": {},
                "completed_tools": [],
            },
            {
                "session_id": "s1",
                "evidence": {},
                "context": [],
                "completed_tools": [],
            },
            {
                "session_id": "s1",
                "evidence": {},
                "context": {},
                "completed_tools": {},
            },
            {
                "session_id": "s1",
                "evidence": {"orders.lookup": "not-an-object"},
                "context": {},
                "completed_tools": [],
            },
            {
                "session_id": "s1",
                "evidence": {},
                "context": {},
                "completed_tools": ["not-an-object"],
            },
        ],
        ids=[
            "evidence_not_object",
            "context_not_object",
            "completed_tools_not_list",
            "evidence_entry_not_object",
            "completed_entry_not_object",
        ],
    )
    def test_raises_helio_error_on_wrong_container_types(
        self,
        payload: dict[str, object],
        mock_api: respx.MockRouter,
    ):
        mock_api.get("/session/s1/state").respond(200, json=payload)

        with HelioClient(session_id="s1") as client:
            with pytest.raises(HelioError) as exc_info:
                client.get_session_state()
            assert exc_info.value.status_code == 200
            assert "malformed response payload" in str(exc_info.value)


class TestContextManager:
    def test_closes_on_exit(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("tool", "key", "data")
        # No exception means close() succeeded


class TestBearerAuth:
    """The SDK reads HELIO_SDK_TOKEN from the environment on construction
    and attaches `Authorization: Bearer <token>` to every sideband request.
    When the env var is unset, no Authorization header is sent (backwards
    compatibility for open-mode local dev, or for operators who have opted
    out of the token)."""

    def test_attaches_bearer_header_when_env_var_is_set(
        self,
        mock_api: respx.MockRouter,
        monkeypatch,
    ):
        monkeypatch.setenv("HELIO_SDK_TOKEN", "test-token-value")
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("tool", "key", "data")

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") == "Bearer test-token-value"

    def test_attaches_bearer_header_to_context_calls(
        self,
        mock_api: respx.MockRouter,
        monkeypatch,
    ):
        monkeypatch.setenv("HELIO_SDK_TOKEN", "another-token")
        mock_api.post("/context").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.set_context("agent_id", "bot")

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") == "Bearer another-token"

    def test_attaches_bearer_header_to_get_session_state(
        self,
        mock_api: respx.MockRouter,
        monkeypatch,
    ):
        monkeypatch.setenv("HELIO_SDK_TOKEN", "yet-another-token")
        mock_api.get("/session/s1/state").respond(
            200,
            json={
                "session_id": "s1",
                "evidence": {},
                "context": {},
                "completed_tools": [],
            },
        )

        with HelioClient(session_id="s1") as client:
            client.get_session_state()

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") == "Bearer yet-another-token"

    def test_omits_authorization_header_when_env_var_is_unset(
        self,
        mock_api: respx.MockRouter,
        clear_sdk_token,
    ):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("tool", "key", "data")

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") is None

    def test_omits_authorization_header_when_env_var_is_empty_string(
        self,
        mock_api: respx.MockRouter,
        monkeypatch,
    ):
        # An empty string is not a valid token; treat it like "unset" so
        # the SDK does not send a malformed Bearer header.
        monkeypatch.setenv("HELIO_SDK_TOKEN", "")
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            client.mark_evidence("tool", "key", "data")

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") is None

    def test_token_is_captured_at_construction_time(
        self,
        mock_api: respx.MockRouter,
        monkeypatch,
    ):
        """Changing HELIO_SDK_TOKEN after construction must not affect an
        already-built client — the token is bound to the underlying httpx
        client's default headers. Operators rotate by restarting the SDK
        process, matching the proxy's rotation model."""
        monkeypatch.setenv("HELIO_SDK_TOKEN", "original-token")
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioClient(session_id="s1") as client:
            monkeypatch.setenv("HELIO_SDK_TOKEN", "rotated-token")
            client.mark_evidence("tool", "key", "data")

        request = mock_api.calls[0].request
        assert request.headers.get("authorization") == "Bearer original-token"
