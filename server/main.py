"""FastAPI server for the privacy-first browser agent.

This process only ever sees SanitizedContext payloads (schemas.py enforces
the shape at the boundary via Pydantic validation) — by the time a request
reaches agent_step(), any PII in the original page has already been
permanently redacted client-side. See the extension's
background/index.ts sendToServer() for the matching client-side assertion.
"""
from __future__ import annotations

import logging
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

import session_store
from gemini_client import interpret_with_vlm
from schemas import AgentStepResponse, SanitizedContext, SessionInfo

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("agent-server")

app = FastAPI(
    title="Privacy-First Browser Agent Server",
    description="Interprets an already-redacted browser screenshot + DOM structure and returns the next agent action.",
    version="0.1.0",
)

# Loosened for local hackathon/dev use — an extension's background worker is
# not a browser page, so CORS doesn't gate it the way it would a fetch() from
# a webpage, but this keeps things simple if you also hit the API from a
# local dev tool or browser-based test harness.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("CORS_ALLOW_ORIGINS", "*").split(","),
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "model": os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")}


@app.post("/agent/step", response_model=AgentStepResponse)
async def agent_step(ctx: SanitizedContext):
    # Redundant, deliberate double-check mirroring the client's own runtime
    # assertion. rawScreenshotIncluded is typed Literal[False], so Pydantic
    # already rejects any payload claiming otherwise — this line exists so
    # the enforcement is visible in the one function that actually talks to
    # the model, not just implied by a type annotation two files away.
    if ctx.rawScreenshotIncluded:
        raise HTTPException(status_code=400, detail="Refusing request: unredacted frame flag set")

    session_store.get_or_create(ctx.sessionId, ctx.taskInstruction)
    step_no = session_store.record_step(ctx.sessionId)

    start = time.perf_counter()
    try:
        action = await interpret_with_vlm(ctx)
    except Exception as exc:  # noqa: BLE001 — surface a clean error to the extension either way
        logger.exception("VLM call failed")
        raise HTTPException(status_code=502, detail=f"VLM call failed: {exc}") from exc
    elapsed_ms = round((time.perf_counter() - start) * 1000)

    logger.info(
        "session=%s step=%s action=%s latency_ms=%s",
        ctx.sessionId,
        step_no,
        action.type,
        elapsed_ms,
    )

    return AgentStepResponse(action=action, sessionId=ctx.sessionId)


@app.get("/sessions", response_model=list[SessionInfo])
async def list_sessions():
    return [
        SessionInfo(
            sessionId=s.session_id,
            stepCount=s.step_count,
            createdAt=s.created_at,
            lastInstruction=s.last_instruction,
        )
        for s in session_store.all_sessions()
    ]


@app.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    session_store.clear(session_id)
    return {"ok": True}
