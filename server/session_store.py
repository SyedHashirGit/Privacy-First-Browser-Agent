"""Minimal in-process session state.

The design doc suggests Redis "or even in-memory dict for hackathon scope."
A dict is genuinely the right call here: state is short-lived (one active
task per session), single-process, and nothing about it needs to survive a
server restart. Swap in Redis (see docker-compose.yml, commented out) only
if you need multiple server workers sharing session state.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field


@dataclass
class Session:
    session_id: str
    step_count: int = 0
    created_at: float = field(default_factory=time.time)
    last_instruction: str = ""


_sessions: dict[str, Session] = {}


def get_or_create(session_id: str, instruction: str) -> Session:
    s = _sessions.get(session_id)
    if s is None:
        s = Session(session_id=session_id, last_instruction=instruction)
        _sessions[session_id] = s
    s.last_instruction = instruction
    return s


def record_step(session_id: str) -> int:
    s = _sessions.get(session_id)
    if s is None:
        s = Session(session_id=session_id)
        _sessions[session_id] = s
    s.step_count += 1
    return s.step_count


def all_sessions() -> list[Session]:
    return list(_sessions.values())


def clear(session_id: str) -> None:
    _sessions.pop(session_id, None)
