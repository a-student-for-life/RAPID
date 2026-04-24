"""
Transcription Router
POST /api/transcribe — accepts audio file, returns structured incident data.

Used by the frontend voice input feature to auto-fill the dispatch form.
Audio is transcribed by Groq Whisper, then parsed into structured JSON by
a Groq LLM, and the location is geocoded via Nominatim.
"""

import logging
from fastapi import APIRouter, UploadFile, File, Form, HTTPException

from services.voice_parser import parse_audio

logger = logging.getLogger(__name__)
router = APIRouter()

# Whisper-Large-V3 supports 99 languages; we expose the ones the UI offers.
_SUPPORTED_LANGUAGES = {"en", "hi", "mr"}


@router.post("/transcribe")
async def transcribe_audio(
    audio: UploadFile = File(...),
    language: str | None = Form(None),
):
    """
    Accept an audio recording and return structured incident data.

    `language` is an optional ISO-639-1 hint ("en", "hi", "mr"). When omitted,
    Whisper auto-detects — but passing the hint improves accuracy noticeably
    for Hindi/Marathi dispatch calls and prevents Devanagari being romanised.

    Returns:
        {
            "transcript":     str,
            "location_text":  str | None,
            "lat":            float | None,
            "lon":            float | None,
            "patient_groups": list[dict],
            "notes":          str,
            "language":       str | None,
        }
    """
    content_type = audio.content_type or "audio/webm"
    audio_bytes  = await audio.read()

    if len(audio_bytes) == 0:
        raise HTTPException(status_code=400, detail="Empty audio file.")

    if len(audio_bytes) > 25 * 1024 * 1024:  # 25 MB Groq limit
        raise HTTPException(status_code=413, detail="Audio file too large (max 25 MB).")

    lang_hint: str | None = None
    if language:
        normalized = language.strip().lower()
        if normalized in _SUPPORTED_LANGUAGES:
            lang_hint = normalized

    try:
        result = await parse_audio(audio_bytes, content_type, lang_hint)
    except ValueError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=500, detail=f"Transcription error: {exc}")

    logger.info("Transcribed [%s]: %s", lang_hint or "auto", result.get("transcript", "")[:80])
    return result
