"""Tests for HelioContext — high-level SDK wrapper."""

from __future__ import annotations

import json

import respx

from helio import HelioContext


# ---------------------------------------------------------------------------
# Shared mock state returned by GET /session/:id/state
# ---------------------------------------------------------------------------

EMPTY_STATE = {
    "session_id": "s1",
    "evidence": {},
    "context": {},
    "completed_tools": [],
}

STATE_WITH_A = {
    "session_id": "s1",
    "evidence": {
        "a": {
            "evidence_key": "a",
            "data": "val-a",
            "tool_name": "tool_a",
            "timestamp": "2026-03-31T10:00:00.000Z",
            "expires_at": 1743415500000,
        }
    },
    "context": {"env": "test"},
    "completed_tools": [
        {
            "tool_name": "tool_a",
            "timestamp": "2026-03-31T10:00:00.000Z",
            "succeeded": True,
        }
    ],
}

STATE_WITH_AB = {
    "session_id": "s1",
    "evidence": {
        "a": {
            "evidence_key": "a",
            "data": "val-a",
            "tool_name": "tool_a",
            "timestamp": "2026-03-31T10:00:00.000Z",
            "expires_at": 1743415500000,
        },
        "b": {
            "evidence_key": "b",
            "data": "val-b",
            "tool_name": "tool_b",
            "timestamp": "2026-03-31T10:00:00.000Z",
            "expires_at": 1743415500000,
        },
    },
    "context": {},
    "completed_tools": [],
}


class TestConstructor:
    def test_creates_client_with_defaults(self):
        ctx = HelioContext()
        assert len(ctx.session_id) == 32
        ctx.close()

    def test_custom_params_forwarded(self):
        ctx = HelioContext(proxy_url="http://localhost:9999", session_id="custom")
        assert ctx.session_id == "custom"
        assert ctx.client.proxy_url == "http://localhost:9999"
        ctx.close()


class TestMarkEvidence:
    def test_delegates_to_client(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioContext(session_id="s1") as ctx:
            ctx.mark_evidence("get_order", "orders.lookup", {"orderId": 42})

        body = json.loads(mock_api.calls[0].request.content)
        assert body["evidence_key"] == "orders.lookup"
        assert body["tool_name"] == "get_order"


class TestRequireEvidence:
    def test_single_key(self):
        ctx = HelioContext()
        ctx.require_evidence("orders.lookup")
        assert "orders.lookup" in ctx._required_keys
        ctx.close()

    def test_list_of_keys(self):
        ctx = HelioContext()
        ctx.require_evidence(["a", "b"])
        assert ctx._required_keys == {"a", "b"}
        ctx.close()

    def test_deduplicates(self):
        ctx = HelioContext()
        ctx.require_evidence("a")
        ctx.require_evidence("a")
        assert len(ctx._required_keys) == 1
        ctx.close()


class TestSet:
    def test_delegates_to_client(self, mock_api: respx.MockRouter):
        mock_api.post("/context").respond(201, json={"ok": True})

        with HelioContext(session_id="s1") as ctx:
            ctx.set("agent_id", "bot")

        body = json.loads(mock_api.calls[0].request.content)
        assert body == {"session_id": "s1", "key": "agent_id", "value": "bot"}


class TestGetEvidenceState:
    def test_all_required_satisfied(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=STATE_WITH_AB)

        with HelioContext(session_id="s1") as ctx:
            ctx.require_evidence(["a", "b"])
            report = ctx.get_evidence_state()

        assert report.satisfied == ["a", "b"]
        assert report.missing == []

    def test_some_missing(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=STATE_WITH_A)

        with HelioContext(session_id="s1") as ctx:
            ctx.require_evidence(["a", "b", "c"])
            report = ctx.get_evidence_state()

        assert report.satisfied == ["a"]
        assert report.missing == ["b", "c"]

    def test_none_required(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=STATE_WITH_A)

        with HelioContext(session_id="s1") as ctx:
            report = ctx.get_evidence_state()

        assert report.satisfied == []
        assert report.missing == []

    def test_all_missing(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=EMPTY_STATE)

        with HelioContext(session_id="s1") as ctx:
            ctx.require_evidence("x")
            report = ctx.get_evidence_state()

        assert report.satisfied == []
        assert report.missing == ["x"]

    def test_returns_full_state(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=STATE_WITH_A)

        with HelioContext(session_id="s1") as ctx:
            report = ctx.get_evidence_state()

        assert report.session_id == "s1"
        assert "a" in report.evidence
        assert report.context == {"env": "test"}
        assert len(report.completed_tools) == 1

    def test_sorted_output(self, mock_api: respx.MockRouter):
        mock_api.get("/session/s1/state").respond(200, json=STATE_WITH_AB)

        with HelioContext(session_id="s1") as ctx:
            ctx.require_evidence(["c", "a", "b"])
            report = ctx.get_evidence_state()

        # Keys should be sorted alphabetically
        assert report.satisfied == ["a", "b"]
        assert report.missing == ["c"]


class TestContextManager:
    def test_closes_on_exit(self, mock_api: respx.MockRouter):
        mock_api.post("/evidence").respond(201, json={"ok": True})

        with HelioContext(session_id="s1") as ctx:
            ctx.mark_evidence("tool", "key", "data")
        # No exception means close() succeeded
