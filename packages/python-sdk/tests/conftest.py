"""Shared fixtures for Helio SDK tests."""

from __future__ import annotations

import pytest
import respx


@pytest.fixture
def mock_api():
    """respx mock router scoped to the default sideband URL."""
    with respx.mock(base_url="http://127.0.0.1:3200") as router:
        yield router
