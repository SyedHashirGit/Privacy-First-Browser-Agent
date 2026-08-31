"""Request/response schemas for the agent server.

These mirror extension/src/lib/types.ts (SanitizedContext, AgentAction) on the
TypeScript side — keep the two in sync if you add fields.
"""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel, Field

PiiCategory = Literal[
    "password",
    "credit_card",
    "email",
    "phone",
    "ssn_or_national_id",
    "address",
    "face",
    "id_document",
    "signature",
    "bank_account",
    "date_of_birth",
    "other_sensitive_text",
]

DetectionSource = Literal["DOM", "VISION"]


class BBox(BaseModel):
    x: int
    y: int
    w: int
    h: int


class InteractableElement(BaseModel):
    selector: str
    tag: str
    text: Optional[str] = None
    role: Optional[str] = None
    box: BBox
    sensitive: bool


class DomNode(BaseModel):
    tag: str
    id: Optional[str] = None
    role: Optional[str] = None
    className: Optional[str] = None
    redacted: Optional[bool] = None
    children: Optional[list["DomNode"]] = None


DomNode.model_rebuild()


class RedactionSummary(BaseModel):
    regionCount: int
    sources: list[DetectionSource]
    categories: list[str] = Field(default_factory=list)


class SanitizedContext(BaseModel):
    """The ONLY shape the server is allowed to receive. Note what's absent:
    no raw screenshot, no text content of redacted fields, no cookies."""

    sessionId: str
    taskInstruction: str
    stepIndex: int
    domStructure: DomNode
    interactables: list[InteractableElement]
    redactedScreenshotB64: str
    redactionSummary: RedactionSummary
    rawScreenshotIncluded: Literal[False] = False


AgentActionType = Literal["click", "type", "scroll", "navigate", "wait", "finish", "ask_user"]


class AgentAction(BaseModel):
    type: AgentActionType
    targetSelector: Optional[str] = None
    text: Optional[str] = None
    url: Optional[str] = None
    reasoning: str
    isFinal: Optional[bool] = None


class AgentStepResponse(BaseModel):
    action: AgentAction
    sessionId: str


class SessionInfo(BaseModel):
    sessionId: str
    stepCount: int
    createdAt: float
    lastInstruction: str
