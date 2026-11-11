"""Tests for Grok ephemeral token minting and the voice log sink."""

from __future__ import annotations

import json
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from httpx import Response

from routers import voice as voice_router


@pytest.fixture()
def voice_app(tmp_path, monkeypatch):
    monkeypatch.setenv("VOICE_LOG", "1")
    monkeypatch.setenv("XAI_API_KEY", "test-xai-key")
    monkeypatch.setattr(voice_router, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(voice_router, "_voice_log_dir", lambda: tmp_path / ".voice-logs")

    app = FastAPI()
    app.include_router(voice_router.router)
    return app, tmp_path


@pytest.fixture()
def client(voice_app):
    app, _ = voice_app
    return TestClient(app)


def test_voice_log_sink_appends_ndjson(client, voice_app):
    _, tmp_path = voice_app
    resp = client.post(
        "/api/voice/log",
        json={"sessionId": "smoke001", "entries": [{"t": 0, "ts": 0, "kind": "start"}]},
    )
    assert resp.status_code == 204
    path = tmp_path / ".voice-logs" / "smoke001.ndjson"
    assert path.exists()
    line = path.read_text(encoding="utf-8").strip()
    assert json.loads(line)["kind"] == "start"


def test_voice_log_sink_rejects_bad_session_id(client):
    resp = client.post(
        "/api/voice/log",
        json={"sessionId": "../x", "entries": []},
    )
    assert resp.status_code == 400


def test_voice_log_sink_404_when_disabled(monkeypatch, tmp_path):
    monkeypatch.delenv("VOICE_LOG", raising=False)
    monkeypatch.setenv("ODS_ENV", "production")
    monkeypatch.setattr(voice_router, "DATA_DIR", str(tmp_path))
    app = FastAPI()
    app.include_router(voice_router.router)
    client = TestClient(app)
    resp = client.post(
        "/api/voice/log",
        json={"sessionId": "smoke001", "entries": [{"kind": "start"}]},
    )
    assert resp.status_code == 404


def test_client_secret_requires_session(client, monkeypatch):
    monkeypatch.setattr(voice_router.session_signer, "verify", lambda _cookie: (False, "missing"))
    resp = client.post("/api/voice/client-secret")
    assert resp.status_code == 401


def test_client_secret_mints_token(client, monkeypatch):
    monkeypatch.setattr(voice_router.session_signer, "verify", lambda _cookie: (True, "ok"))

    upstream = Response(
        200,
        json={"value": "xai-realtime-client-secret-test", "expires_at": 1_700_000_000},
        request=MagicMock(),
    )

    class _FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def post(self, *args, **kwargs):
            return upstream

    monkeypatch.setattr(voice_router.httpx, "AsyncClient", lambda **kwargs: _FakeClient())

    resp = client.post(
        "/api/voice/client-secret",
        headers={"X-Voice-Session-Id": "ab12cd34"},
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["value"] == "xai-realtime-client-secret-test"
    assert "grok-voice-latest" in data["ws_url"]
    assert data["value"].startswith("xai-")
