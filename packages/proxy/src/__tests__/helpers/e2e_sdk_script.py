"""E2E helper: SDK evidence submission. Invoked by Vitest as subprocess.

On success, prints a JSON summary of the session state to stdout and exits 0.
On `HelioError` (e.g. a 401 from the sideband when the bearer token is
missing), prints a JSON error payload to stderr and exits 1 so the Vitest
harness can assert on the failure mode without parsing stack traces.
"""

import json
import sys

from helio import HelioContext, HelioError


def main() -> None:
    proxy_url = sys.argv[1]  # sideband URL, e.g. "http://127.0.0.1:PORT"
    session_id = sys.argv[2]  # e.g. "e2e-session-1"

    try:
        with HelioContext(proxy_url=proxy_url, session_id=session_id) as ctx:
            ctx.require_evidence(["orders.lookup"])

            # Mark evidence via the sideband API
            ctx.mark_evidence("get_order", "orders.lookup", {"orderId": 42})

            # Fetch state and verify requirement comparison
            state = ctx.get_evidence_state()
            result = {
                "session_id": state.session_id,
                "satisfied": state.satisfied,
                "missing": state.missing,
                "evidence_keys": list(state.evidence.keys()),
            }
            print(json.dumps(result))
    except HelioError as exc:
        error_payload = {
            "error": str(exc),
            "status_code": exc.status_code,
        }
        print(json.dumps(error_payload), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
