import React, { useState, useRef } from 'react'
import axios from 'axios'

/**
 * Voice input button — records audio via MediaRecorder, sends to
 * POST /api/transcribe, and calls onParsed with the structured result
 * so the parent form can auto-fill.
 */
export default function VoiceInput({ onParsed }) {
  const [state,      setState]      = useState('idle')   // idle | recording | processing | done | error
  const [transcript, setTranscript] = useState('')
  const [errorMsg,   setErrorMsg]   = useState('')
  const mediaRecorderRef = useRef(null)
  const chunksRef        = useRef([])

  async function startRecording() {
    setErrorMsg('')
    setTranscript('')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm'

      const recorder = new MediaRecorder(stream, { mimeType })
      chunksRef.current = []
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data) }
      recorder.onstop = () => { stream.getTracks().forEach(t => t.stop()) }
      mediaRecorderRef.current = recorder
      recorder.start()
      setState('recording')
    } catch (err) {
      setErrorMsg('Microphone access denied')
      setState('error')
    }
  }

  async function stopAndSend() {
    setState('processing')
    const recorder = mediaRecorderRef.current
    if (!recorder) return

    recorder.stop()
    // Wait for final chunk
    await new Promise(resolve => { recorder.onstop = () => { recorder.stream?.getTracks().forEach(t => t.stop()); resolve() } })

    const blob     = new Blob(chunksRef.current, { type: 'audio/webm' })
    const formData = new FormData()
    formData.append('audio', blob, 'recording.webm')

    try {
      const res = await axios.post('/api/transcribe', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 30000,
      })
      setTranscript(res.data.transcript || '')
      setState('done')
      onParsed(res.data)
    } catch (err) {
      setErrorMsg(err.response?.data?.detail || 'Transcription failed')
      setState('error')
    }
  }

  function handleClick() {
    if (state === 'idle' || state === 'done' || state === 'error') startRecording()
    else if (state === 'recording') stopAndSend()
  }

  const isRecording  = state === 'recording'
  const isProcessing = state === 'processing'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleClick}
          disabled={isProcessing}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded border text-xs font-semibold transition-all
            ${isRecording
              ? 'bg-red-900/40 border-red-500 text-red-300 animate-pulse'
              : isProcessing
                ? 'bg-rapid-surface border-rapid-border text-slate-500 cursor-not-allowed'
                : 'bg-rapid-surface border-rapid-border text-slate-400 hover:border-blue-500 hover:text-blue-300'
            }`}
        >
          {isProcessing ? (
            <>
              <svg className="animate-spin w-3 h-3" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"/>
              </svg>
              Transcribing…
            </>
          ) : isRecording ? (
            <>
              <span className="w-2 h-2 rounded-full bg-red-400 inline-block" />
              Stop & Send
            </>
          ) : (
            <>🎤 Voice Input</>
          )}
        </button>

        {state === 'done' && (
          <span className="text-xs text-green-400">✓ Form filled</span>
        )}
      </div>

      {transcript && (
        <p className="text-xs text-slate-500 italic leading-snug">
          "{transcript.length > 80 ? transcript.slice(0, 80) + '…' : transcript}"
        </p>
      )}

      {errorMsg && (
        <p className="text-xs text-red-400">{errorMsg}</p>
      )}

      {state === 'idle' && (
        <p className="text-xs text-slate-600">
          e.g. "Building collapse at Dharavi, 30 casualties, crush injuries"
        </p>
      )}
    </div>
  )
}
