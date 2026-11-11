"""Voice services status, Grok ephemeral tokens, and dev-only voice log sink."""

from __future__ import annotations

import json
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response

import session_signer
from config import DATA_DIR, INSTALL_DIR
from performance_oracle import read_env_file_value
from security import verify_api_key

logger = logging.getLogger(__name__)

router = APIRouter(tags=["voice"])

# Whisper (STT) and Kokoro (TTS) are the voice stack ODS ships, so both have to
# be healthy for voice to be usable. LiveKit is an optional add-on that is
# absent from SERVICES unless an operator installs it — an install without it
# is complete, not degraded, and must not drag the verdict down.
REQUIRED_VOICE_SERVICES = ("stt", "tts")
NOT_CONFIGURED = "not_configured"

SESSION_COOKIE_NAME = "ods-session"
XAI_CLIENT_SECRETS_URL = "https://api.x.ai/v1/realtime/client_secrets"
VOICE_SESSION_ID_RE = re.compile(r"^[a-z0-9]{4,64}$")
MAX_LOG_ENTRIES_PER_REQUEST = 500
MAX_LOG_LINE_CHARS = 16_000


def _xai_api_key() -> str:
    key = (os.environ.get("XAI_API_KEY") or "").strip()
    if key:
        return key
    # Fallback: compose may mount .env without injecting every key into the
    # process environment on older overlays.
    return (read_env_file_value("XAI_API_KEY", INSTALL_DIR) or "").strip()


def _voice_logging_enabled() -> bool:
    if os.environ.get("VOICE_LOG", "").strip() == "1":
        return True
    env = (os.environ.get("ODS_ENV") or os.environ.get("ENVIRONMENT") or "").strip().lower()
    if env in ("production", "prod"):
        return False
    return env in ("development", "dev", "local", "test")


def _voice_log_dir() -> Path:
    override = (os.environ.get("VOICE_LOG_DIR") or "").strip()
    if override:
        return Path(override)
    return Path(DATA_DIR) / ".voice-logs"


def _require_talk_session(request: Request) -> None:
    cookie_value = request.cookies.get(SESSION_COOKIE_NAME, "")
    ok, reason = session_signer.verify(cookie_value)
    if not ok:
        logger.info("voice session denied: reason=%s", reason)
        raise HTTPException(
            status_code=401,
            detail="Scan the owner card again to start a ODS Talk session.",
        )


def _append_voice_log(session_id: str, entries: list[dict[str, Any]]) -> None:
    log_dir = _voice_log_dir()
    log_dir.mkdir(parents=True, exist_ok=True)
    path = log_dir / f"{session_id}.ndjson"
    lines: list[str] = []
    for entry in entries[:MAX_LOG_ENTRIES_PER_REQUEST]:
        line = json.dumps(entry, ensure_ascii=False, separators=(",", ":"))
        if len(line) > MAX_LOG_LINE_CHARS:
            continue
        lines.append(line)
    if not lines:
        return
    with path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


@router.get("/api/voice/status")
async def voice_status(api_key: str = Depends(verify_api_key)):
    """Return voice services availability status.

    Stub implementation — returns service health based on the existing
    service health infrastructure. Full voice API is not yet implemented.
    """
    from helpers import check_service_health
    from config import SERVICES

    services_status = {}
    for svc_key, display_name in [("whisper", "stt"), ("tts", "tts")]:
        cfg = SERVICES.get(svc_key)
        if cfg:
            try:
                result = await check_service_health(svc_key, cfg)
                services_status[display_name] = {"status": result.status}
            except Exception:
                logger.warning("Health check failed for %s", svc_key, exc_info=True)
                services_status[display_name] = {"status": "unavailable"}
        else:
            services_status[display_name] = {"status": NOT_CONFIGURED}

    # LiveKit is optional and not in SERVICES by default
    livekit_cfg = SERVICES.get("livekit")
    if livekit_cfg:
        try:
            result = await check_service_health("livekit", livekit_cfg)
            services_status["livekit"] = {"status": result.status}
        except Exception:
            logger.warning("Health check failed for livekit", exc_info=True)
            services_status["livekit"] = {"status": "unavailable"}
    else:
        services_status["livekit"] = {"status": NOT_CONFIGURED}

    # An uninstalled optional service is not a failure, so it sits out the
    # verdict. Everything that IS installed still has to be healthy.
    required_healthy = all(
        services_status.get(name, {}).get("status") == "healthy"
        for name in REQUIRED_VOICE_SERVICES
    )
    installed_healthy = all(
        entry["status"] == "healthy"
        for entry in services_status.values()
        if entry["status"] != NOT_CONFIGURED
    )
    all_healthy = required_healthy and installed_healthy

    return {
        "available": all_healthy,
        "services": services_status,
        "grok_voice_configured": bool(_xai_api_key()),
        "message": "All voice services operational" if all_healthy else "Some voice services unavailable",
    }


@router.post("/api/voice/client-secret")
async def create_voice_client_secret(request: Request) -> dict[str, Any]:
    """Mint a short-lived xAI realtime client secret for browser WebSockets.

    Long-lived ``XAI_API_KEY`` never leaves the server. ODS Talk sessions are
    cookie-gated so the injected dashboard API key alone cannot mint tokens.
    """
    _require_talk_session(request)
    api_key = _xai_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Grok voice is not configured. Set XAI_API_KEY on the host.",
        )

    debug_session_id = (request.headers.get("x-voice-session-id") or "").strip().lower()
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            upstream = await client.post(
                XAI_CLIENT_SECRETS_URL,
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={"expires_after": {"seconds": 300}},
            )
    except httpx.HTTPError as exc:
        ms = int((time.perf_counter() - started) * 1000)
        if _voice_logging_enabled() and VOICE_SESSION_ID_RE.match(debug_session_id):
            _append_voice_log(debug_session_id, [{
                "ts": int(time.time() * 1000),
                "kind": "server.token",
                "src": "server",
                "ok": False,
                "status": 0,
                "ms": ms,
                "upstream": "network_error",
            }])
        raise HTTPException(status_code=502, detail="Could not reach xAI client_secrets.") from exc

    ms = int((time.perf_counter() - started) * 1000)
    ok = upstream.is_success
    if _voice_logging_enabled() and VOICE_SESSION_ID_RE.match(debug_session_id):
        _append_voice_log(debug_session_id, [{
            "ts": int(time.time() * 1000),
            "kind": "server.token",
            "src": "server",
            "ok": ok,
            "status": upstream.status_code,
            "ms": ms,
            "upstream": "api.x.ai",
        }])

    if not ok:
        raise HTTPException(
            status_code=502,
            detail=f"xAI client_secrets returned HTTP {upstream.status_code}.",
        )

    payload = upstream.json()
    value = payload.get("value") if isinstance(payload, dict) else None
    if not isinstance(value, str) or not value.strip():
        raise HTTPException(status_code=502, detail="xAI client_secrets response missing value.")

    return {
        "value": value,
        "expires_at": payload.get("expires_at"),
        "model": "grok-voice-latest",
        "ws_url": "wss://api.x.ai/v1/realtime?model=grok-voice-latest",
    }


@router.post("/api/voice/log")
async def voice_log_sink(request: Request) -> Response:
    """Dev-only NDJSON sink for Grok voice session debugging."""
    if not _voice_logging_enabled():
        raise HTTPException(status_code=404, detail="Not found")

    try:
        body = await request.json()
    except Exception as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON body.") from exc

    session_id = body.get("sessionId") if isinstance(body, dict) else None
    entries = body.get("entries") if isinstance(body, dict) else None
    if not isinstance(session_id, str) or not VOICE_SESSION_ID_RE.match(session_id):
        raise HTTPException(status_code=400, detail="Invalid sessionId.")
    if not isinstance(entries, list):
        raise HTTPException(status_code=400, detail="entries must be an array.")

    cleaned: list[dict[str, Any]] = []
    for entry in entries:
        if isinstance(entry, dict):
            cleaned.append(entry)
    _append_voice_log(session_id, cleaned)
    return Response(status_code=204)
