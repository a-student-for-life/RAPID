"""Disk-backed image store — images persist across backend restarts.

Files are written to rapid-backend/uploads/{uuid}.{ext} with a matching
{uuid}.mime sidecar. Falls back to an in-memory dict if the directory
isn't writable (e.g. read-only deploy environments).
"""
from __future__ import annotations

import uuid
from pathlib import Path

UPLOAD_DIR = Path(__file__).parent.parent / "uploads"

try:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    _disk_ok = True
except Exception:
    _disk_ok = False

_mem: dict[str, tuple[bytes, str]] = {}


def _ext(mime: str) -> str:
    """Best-effort file extension from a MIME type."""
    part = (mime or "image/jpeg").split("/")[-1].split(";")[0].strip()
    return {"jpeg": "jpg", "svg+xml": "svg"}.get(part, part) or "jpg"


def save(data: bytes, mime: str) -> str:
    """Store image bytes and return a new UUID image_id."""
    image_id = str(uuid.uuid4())
    if _disk_ok:
        try:
            (UPLOAD_DIR / f"{image_id}.{_ext(mime)}").write_bytes(data)
            (UPLOAD_DIR / f"{image_id}.mime").write_text(mime or "image/jpeg", encoding="utf-8")
            return image_id
        except Exception:
            pass
    _mem[image_id] = (data, mime or "image/jpeg")
    return image_id


def get(image_id: str) -> tuple[bytes, str] | None:
    """Return (bytes, mime) or None if not found."""
    if _disk_ok:
        for path in UPLOAD_DIR.glob(f"{image_id}.*"):
            if path.suffix == ".mime":
                continue
            try:
                data = path.read_bytes()
                mime_path = UPLOAD_DIR / f"{image_id}.mime"
                mime = mime_path.read_text(encoding="utf-8") if mime_path.exists() else "image/jpeg"
                return data, mime
            except Exception:
                break
    return _mem.get(image_id)
