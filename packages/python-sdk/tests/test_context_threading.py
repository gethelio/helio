"""Thread-safety tests for HelioContext.require_evidence.

The HelioContext wraps a mutable `_required_keys` set that consumers can
update at any time via `require_evidence`. When multiple threads call that
method concurrently, Python set operations are not atomic under all
interpreters (CPython's GIL masks many races, but not all — `set.update()`
with a large iterable can release the GIL mid-mutation, and PyPy and other
runtimes give weaker guarantees). The SDK promises thread-safe mutation
regardless of interpreter.
"""

from __future__ import annotations

import threading
from unittest.mock import patch

from helio import HelioContext
from helio.types import SessionState


def test_helio_context_exposes_a_lock():
    """The context must own a `_lock` attribute so mutation and snapshot
    reads serialize correctly even on interpreters without a GIL."""
    ctx = HelioContext(proxy_url="http://127.0.0.1:65535", session_id="s1")
    try:
        # `threading.Lock()` returns an object whose type is a C extension,
        # so the cleanest invariant to assert is "has acquire/release and is
        # a context manager" — not isinstance on a private class.
        lock = getattr(ctx, "_lock", None)
        assert lock is not None, "HelioContext must expose a _lock attribute"
        assert hasattr(lock, "acquire")
        assert hasattr(lock, "release")
        with lock:
            pass  # context-manager protocol
    finally:
        ctx.close()


def test_get_evidence_state_snapshot_is_consistent_under_contention():
    """While get_evidence_state is in the middle of its network call,
    concurrent require_evidence updates must not tear the snapshot that
    get_evidence_state is computing against. The lock must be released
    before the network fetch so the reader never blocks the writer for
    long, but the snapshot itself must be atomic.
    """
    ctx = HelioContext(proxy_url="http://127.0.0.1:65535", session_id="s1")
    try:
        ctx.require_evidence(["a", "b", "c"])

        # Mock out the HTTP fetch so we do not actually hit a proxy.
        mock_state = SessionState(
            session_id="s1",
            evidence={},
            context={},
            completed_tools=[],
        )

        with patch.object(ctx._client, "get_session_state", return_value=mock_state):
            report = ctx.get_evidence_state()

        # Report must contain exactly the keys we required, sorted.
        assert sorted(report.missing) == ["a", "b", "c"]
        assert report.satisfied == []
    finally:
        ctx.close()


def test_require_evidence_is_thread_safe_under_concurrent_updates():
    """Concurrent require_evidence calls must not drop keys or raise."""
    ctx = HelioContext(proxy_url="http://127.0.0.1:65535", session_id="s1")
    try:
        thread_count = 10
        keys_per_thread = 100
        errors: list[BaseException] = []
        barrier = threading.Barrier(thread_count)

        def worker(tid: int):
            try:
                barrier.wait()
                for i in range(keys_per_thread):
                    ctx.require_evidence(f"thread-{tid}-key-{i}")
            except BaseException as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=worker, args=(t,)) for t in range(thread_count)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == [], f"workers raised: {errors}"
        # Every thread wrote keys_per_thread unique keys, and no two threads
        # share a key, so the final set must have exactly thread_count *
        # keys_per_thread entries.
        required = ctx._required_keys
        assert len(required) == thread_count * keys_per_thread
        for t in range(thread_count):
            for i in range(keys_per_thread):
                assert f"thread-{t}-key-{i}" in required
    finally:
        ctx.close()


def test_require_evidence_accepts_mixed_list_and_string_under_contention():
    """A mix of list and string args must still land in the set."""
    ctx = HelioContext(proxy_url="http://127.0.0.1:65535", session_id="s2")
    try:
        thread_count = 8
        errors: list[BaseException] = []
        barrier = threading.Barrier(thread_count)

        def worker(tid: int):
            try:
                barrier.wait()
                ctx.require_evidence(f"single-{tid}")
                ctx.require_evidence([f"batch-{tid}-a", f"batch-{tid}-b"])
            except BaseException as exc:
                errors.append(exc)

        threads = [
            threading.Thread(target=worker, args=(t,)) for t in range(thread_count)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert errors == []
        required = ctx._required_keys
        for t in range(thread_count):
            assert f"single-{t}" in required
            assert f"batch-{t}-a" in required
            assert f"batch-{t}-b" in required
    finally:
        ctx.close()
