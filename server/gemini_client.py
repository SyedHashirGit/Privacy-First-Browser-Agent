"""Wraps the Gemini 2.5 Flash call that turns a sanitized context into the
next agent action.

The server never receives raw pixels — see schemas.SanitizedContext and the
extension's redaction-before-network-call gate in background/index.ts. This
file's only job is: sanitized context in, one AgentAction out.
"""
from __future__ import annotations

import base64
import json
import os

from google import genai
from google.genai import types

from schemas import AgentAction, DomNode, InteractableElement, SanitizedContext

MODEL_ID = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash")

_client: genai.Client | None = None


def get_client() -> genai.Client:
    global _client
    if _client is None:
        api_key = os.environ.get("GEMINI_API_KEY")
        if not api_key:
            raise RuntimeError(
                "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key, "
                "or export GEMINI_API_KEY before starting the server."
            )
        _client = genai.Client(api_key=api_key)
    return _client


# The response schema the model must fill in. Constraining generation to this
# shape (response_mime_type=application/json + response_schema) means we get
# a directly-parseable AgentAction back instead of parsing free text — much
# more reliable for something that's about to click things.
ACTION_RESPONSE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "type": {
            "type": "STRING",
            "enum": ["click", "type", "scroll", "navigate", "wait", "finish", "ask_user"],
        },
        "targetSelector": {
            "type": "STRING",
            "description": "CSS selector of the element to act on, copied exactly from the interactables list. Omit for scroll-with-no-target/navigate/wait/finish/ask_user.",
        },
        "text": {
            "type": "STRING",
            "description": "Text to type, only for type actions. Never used for password/card/SSN-tagged fields.",
        },
        "url": {"type": "STRING", "description": "Destination URL, only for navigate actions."},
        "reasoning": {
            "type": "STRING",
            "description": "One or two sentences: what you see and why this is the right next step.",
        },
        "isFinal": {"type": "BOOLEAN", "description": "True only when the task instruction is now complete."},
    },
    "required": ["type", "reasoning"],
}


SYSTEM_INSTRUCTION = """You are the planning component of a privacy-preserving browser agent.

You are shown a screenshot of the current browser tab where every region of
personally identifiable information has ALREADY been permanently redacted
with a solid black box before it ever reached you — passwords, card numbers,
national ID numbers, faces, and similar. This is intentional and structural,
not a bug: you must never ask for what's under those boxes, never instruct
the client to read or transmit their contents, and never treat a redacted
box as something to click into for the purpose of reading it. You may still
click a redacted field's box (e.g. to focus a login field a human will fill
in themselves) but you must never supply `text` for a `type` action whose
target is flagged sensitive in the interactables list.

You also receive:
- A structural (tag/id/role only, no text) DOM tree for extra layout context.
- A flat list of interactive elements on the page with CSS selectors you can
  target directly — always copy `targetSelector` verbatim from this list,
  never invent a selector.
- The user's task instruction and which step number this is.

Decide exactly ONE next action that makes progress on the task. Prefer the
most direct, safe action. If the task is already complete, return type
"finish" with isFinal true. If you genuinely cannot proceed without more
information from the human (e.g. the task requires entering a password,
choosing between ambiguous options, or providing information only they have),
return type "ask_user" and explain what you need in `reasoning`. Never
fabricate having typed something into a sensitive field — ask_user instead.

Respond with exactly one JSON object matching the provided schema. No
markdown, no commentary outside the JSON.
"""


def _build_prompt_text(ctx: SanitizedContext) -> str:
    interactables_view = [
        {
            "selector": el.selector,
            "tag": el.tag,
            "text": el.text,
            "role": el.role,
            "sensitive": el.sensitive,
        }
        for el in ctx.interactables
    ]
    return json.dumps(
        {
            "task_instruction": ctx.taskInstruction,
            "step_index": ctx.stepIndex,
            "dom_structure": ctx.domStructure.model_dump(exclude_none=True),
            "interactable_elements": interactables_view,
            "redaction_summary": ctx.redactionSummary.model_dump(),
        },
        indent=2,
    )


import urllib.request
import urllib.error
import asyncio

async def _call_ollama_fallback(ctx: SanitizedContext) -> str:
    url = os.environ.get("OLLAMA_URL", "http://localhost:11434/api/generate")
    payload = {
        "model": "llava",
        "system": SYSTEM_INSTRUCTION,
        "prompt": _build_prompt_text(ctx),
        "images": [ctx.redactedScreenshotB64],
        "format": ACTION_RESPONSE_SCHEMA,
        "stream": False,
        "options": {"temperature": 0.2}
    }
    def _post():
        req = urllib.request.Request(
            url, 
            data=json.dumps(payload).encode('utf-8'), 
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read().decode('utf-8')).get('response', '')
    
    return await asyncio.to_thread(_post)


async def interpret_with_vlm(ctx: SanitizedContext) -> AgentAction:
    client = get_client()

    image_bytes = base64.b64decode(ctx.redactedScreenshotB64)
    image_part = types.Part.from_bytes(data=image_bytes, mime_type="image/png")
    text_part = types.Part.from_text(text=_build_prompt_text(ctx))

    config = types.GenerateContentConfig(
        system_instruction=SYSTEM_INSTRUCTION,
        temperature=0.2,
        response_mime_type="application/json",
        response_schema=ACTION_RESPONSE_SCHEMA,
    )

    raw = ""
    try:
        # Wrap the synchronous genai call in a thread to avoid blocking the event loop
        response = await asyncio.to_thread(
            client.models.generate_content,
            model=MODEL_ID,
            contents=[types.Content(role="user", parts=[image_part, text_part])],
            config=config,
        )
        raw = response.text
    except Exception as e:
        print(f"Gemini API failed ({e}), trying fallback API key...")
        fallback_key = os.environ.get("GEMINI_FALLBACK_API_KEY")
        if fallback_key:
            try:
                fallback_client = genai.Client(api_key=fallback_key)
                response = await asyncio.to_thread(
                    fallback_client.models.generate_content,
                    model=MODEL_ID,
                    contents=[types.Content(role="user", parts=[image_part, text_part])],
                    config=config,
                )
                raw = response.text
            except Exception as fallback_e:
                print(f"Fallback Gemini API failed ({fallback_e}), falling back to Ollama gemma3...")
                try:
                    raw = await _call_ollama_fallback(ctx)
                except Exception as ollama_err:
                    raise RuntimeError(f"All fallbacks failed. Gemini error: {e}. Ollama error: {ollama_err}") from ollama_err
        else:
            print(f"No fallback Gemini API key found, falling back to Ollama gemma3...")
            try:
                raw = await _call_ollama_fallback(ctx)
            except Exception as ollama_err:
                raise RuntimeError(f"Both Gemini and Ollama fallback failed. Gemini error: {e}. Ollama error: {ollama_err}") from ollama_err
    if not raw:
        return AgentAction(
            type="ask_user",
            reasoning="The model returned an empty response. Try rephrasing the task or retry the step.",
        )

    data = json.loads(raw)
    action = AgentAction(**data)

    # Belt-and-braces server-side check mirroring the client's own refusal:
    # never let a typed value target a selector the client flagged sensitive.
    if action.type == "type" and action.targetSelector:
        target = next((el for el in ctx.interactables if el.selector == action.targetSelector), None)
        if target and target.sensitive:
            return AgentAction(
                type="ask_user",
                reasoning="The requested action would type into a field flagged as sensitive. "
                "Please enter that value yourself; the agent will continue from there.",
            )

    return action
