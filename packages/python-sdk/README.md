# Helio Python SDK

Thin Python client for the [Helio MCP governance proxy](https://github.com/gethelio/helio). Communicates with the proxy's sideband HTTP API to report evidence and context. The SDK never makes governance decisions — that is always the proxy's job.

## Install

```bash
pip install helio-client
```

> **`helio-client` is only the PyPI distribution name** — the string you `pip install`. This package is the **Helio Python SDK**; the distribution name differs solely because the bare `helio` name on PyPI is held by an unrelated abandoned project. It changes nothing about how you use the SDK — the import path stays `helio` (`from helio import HelioContext`), and these docs refer to it as the Helio Python SDK throughout.

## Quick Start

The proxy prints a per-boot SDK token to stderr on startup (`SDK token (pass as HELIO_SDK_TOKEN env var to your SDK clients): ...`). Export it in the environment where your SDK client runs — the client reads `HELIO_SDK_TOKEN` automatically and attaches it as `Authorization: Bearer <token>` on every sideband call. Without it, requests to the proxy sideband are rejected with `401`.

```bash
export HELIO_SDK_TOKEN=<token-from-proxy-startup-logs>
```

```python
from helio import HelioContext

with HelioContext(proxy_url="http://127.0.0.1:3200") as ctx:
    # Declare what evidence this session needs
    ctx.require_evidence("orders.lookup")

    # Mark tool output as evidence under the required key
    ctx.mark_evidence("get_order", "orders.lookup", {"orderId": 42})

    # Set arbitrary session context
    ctx.set("agent_id", "support-bot")

    # Check what evidence the proxy has
    report = ctx.get_evidence_state()
    print(report.satisfied)  # ['orders.lookup']
    print(report.missing)    # []
```

## API

### HelioContext

High-level wrapper with local requirement tracking.

| Method | Description |
|--------|-------------|
| `mark_evidence(tool_name, evidence_key, data, ttl=300)` | Report evidence from a tool output |
| `require_evidence(keys)` | Declare local requirements (informational) |
| `set(key, value)` | Set arbitrary session context |
| `get_evidence_state()` | Get evidence state with satisfied/missing comparison |

### HelioClient

Low-level HTTP client mapping to the sideband API.

| Method | Endpoint | Description |
|--------|----------|-------------|
| `mark_evidence(tool_name, evidence_key, data, ttl=300)` | `POST /evidence` | Report evidence |
| `set_context(key, value)` | `POST /context` | Set session context |
| `get_session_state()` | `GET /session/:session_id/state` | Fetch combined state |

### HelioError

All SDK methods raise `HelioError` on failure instead of raw HTTP exceptions. The error includes an actionable message and an optional `status_code` attribute.

```python
from helio import HelioContext, HelioError

try:
    with HelioContext() as ctx:
        ctx.mark_evidence("tool", "key", "data")
except HelioError as e:
    print(e)              # "POST /evidence failed: HTTP 400"
    print(e.status_code)  # 400
```

Caught error types:
- **Connection errors** — proxy unreachable (`"Cannot connect to proxy at ..."`)
- **Timeout errors** — proxy did not respond in time (`"Proxy request timed out: ..."`)
- **HTTP errors** — proxy returned 4xx/5xx (`"POST /evidence failed: HTTP 400"`)
- **Serialization errors** — request payload is not JSON-serializable for POST calls (for example, `{"v": object()}`), normalized to `HelioError` with endpoint context (`"Failed to serialize POST /evidence payload as JSON: ..."`).
- **Evidence allowlist errors** — `POST /evidence` may return `code=evidence_key_not_in_policy_allowlist` when `evidence_key` does not match any policy `evidence.requires` key. The SDK includes the rejected key and configured-key preview in `HelioError` for quick diagnosis.
- **Malformed sideband responses** — invalid JSON or missing fields from `GET /session/:session_id/state` are normalized to `HelioError` (`"... returned malformed response payload"`).

## Configuration

| Parameter | Default | Description |
|-----------|---------|-------------|
| `proxy_url` | `http://127.0.0.1:3200` | Sideband API base URL |
| `session_id` | Auto-generated UUID | Correlation key for evidence/context |
| `timeout` | `5.0` | HTTP request timeout in seconds |

## Constraints

- **Under 500 lines** — governance logic belongs in the proxy, not the SDK
- **Thin client only** — no caching, no policy evaluation, no decision-making
- **Python 3.10+** required

## License

Apache 2.0
