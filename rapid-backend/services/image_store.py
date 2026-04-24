"""In-memory image store — maps image_id to (bytes, mime_type).

Intentionally simple: a module-level dict keyed by UUID. Images live for the
lifetime of the backend process. The dispatcher uses GET /api/images/{id} to
view thumbnails; the ID is stored alongside scene assessment + bystander docs.
"""
from __future__ import annotations

import uuid

_store: dict[str, tuple[bytes, str]] = {}


def save(data: bytes, mime: str) -> str:
    """Store raw image bytes and return a new UUID image_id."""
    image_id = str(uuid.uuid4())
    _store[image_id] = (data, mime or "image/jpeg")
    return image_id


def get(image_id: str) -> tuple[bytes, str] | None:
    """Return (bytes, mime) or None if not found."""
    return _store.get(image_id)
