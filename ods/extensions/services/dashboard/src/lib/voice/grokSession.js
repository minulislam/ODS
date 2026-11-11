import { createVoiceLogger, makeVoiceSessionId } from './logger'
import { startMicCapture } from './capture'
import { createPcmPlayer } from './playback'
import { TARGET_RATE } from './pcm'

const DEFAULT_INSTRUCTIONS = [
  'You are ODS, a helpful local AI assistant speaking with the user.',
  'Keep replies concise and conversational for voice.',
  'If you are unsure, say so briefly.',
].join(' ')

function voiceLoggingEnabled(force = false) {
  try {
    if (force) return true
    if (import.meta.env?.DEV) return true
    if (import.meta.env?.MODE === 'test') return true
    return globalThis.localStorage?.getItem('ods-voice-log') === '1'
  } catch {
    return false
  }
}

/**
 * Start a Grok duplex voice session.
 * Call from a user-gesture handler so AudioContext can resume.
 */
export async function startGrokVoiceSession({
  voice = 'eve',
  instructions = DEFAULT_INSTRUCTIONS,
  onPhase,
  onUserTranscript,
  onAssistantTranscript,
  onError,
  onSessionMeta,
  enableLogging = false,
} = {}) {
  const sessionId = makeVoiceSessionId()
  const logger = createVoiceLogger(sessionId, { enabled: voiceLoggingEnabled(enableLogging) })
  onSessionMeta?.({ sessionId })

  let phase = 'connecting'
  const setPhase = (next) => {
    if (phase === next) return
    phase = next
    logger.log('phase', { phase: next })
    onPhase?.(next, sessionId)
  }
  setPhase('connecting')

  const AudioCtx = window.AudioContext || window.webkitAudioContext
  const audioContext = new AudioCtx({ sampleRate: TARGET_RATE })
  try {
    await audioContext.resume()
  } catch (err) {
    logger.error('audio.resume', err)
  }

  const player = createPcmPlayer(audioContext, { rate: TARGET_RATE })
  const earlyChunks = []
  const EARLY_CAP = 50
  let ws = null
  let capture = null
  let closed = false
  let speechStoppedT = 0
  let createdT = 0
  let responseAudio = null
  let audioInWindow = null

  const sendClient = (event) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    logger.client(event)
    ws.send(JSON.stringify(event))
  }

  const flushEarly = () => {
    if (!earlyChunks.length) return
    logger.log('audio.flush', { chunks: earlyChunks.length })
    for (const chunk of earlyChunks) {
      sendClient({ type: 'input_audio_buffer.append', audio: chunk.base64 })
    }
    earlyChunks.length = 0
  }

  const noteAudioIn = (chunk) => {
    const now = Date.now()
    if (!audioInWindow || now - audioInWindow.t0 >= 2000) {
      if (audioInWindow) {
        logger.log('audio.in', {
          chunks: audioInWindow.chunks,
          bytes: audioInWindow.bytes,
          rms_max: audioInWindow.rmsMax,
          rms_avg: audioInWindow.rmsSum / Math.max(1, audioInWindow.chunks),
          pending: earlyChunks.length,
          mic_state: capture ? 'live' : 'none',
          phase,
        })
      }
      audioInWindow = { t0: now, chunks: 0, bytes: 0, rmsMax: 0, rmsSum: 0 }
    }
    audioInWindow.chunks += 1
    audioInWindow.bytes += chunk.bytes
    audioInWindow.rmsMax = Math.max(audioInWindow.rmsMax, chunk.rms)
    audioInWindow.rmsSum += chunk.rms
  }

  const handleServerEvent = (event) => {
    const type = event?.type
    if (type === 'response.output_audio.delta' || type === 'response.audio.delta') {
      const b64 = event.delta || event.audio || ''
      if (!b64) return
      if (!responseAudio) {
        responseAudio = {
          response_id: event.response_id || event.item_id || 'unknown',
          deltas: 0,
          bytes: 0,
          started: Date.now(),
          lastDeltaT: Date.now(),
          maxGapMs: 0,
        }
        const played = player.enqueueBase64(b64)
        responseAudio.bytes += played.bytes
        responseAudio.deltas += 1
        logger.log('audio.out.first', {
          response_id: responseAudio.response_id,
          bytes: played.bytes,
          since_response_created_ms: createdT ? Date.now() - createdT : null,
          since_speech_stopped_ms: speechStoppedT ? Date.now() - speechStoppedT : null,
          play_state: audioContext.state,
        })
        setPhase('speaking')
        return
      }
      const gap = Date.now() - responseAudio.lastDeltaT
      if (gap > responseAudio.maxGapMs) responseAudio.maxGapMs = gap
      responseAudio.lastDeltaT = Date.now()
      const played = player.enqueueBase64(b64)
      responseAudio.bytes += played.bytes
      responseAudio.deltas += 1
      return
    }

    logger.server(event, { phase })

    if (type === 'session.updated' || type === 'session.created') {
      setPhase('listening')
    } else if (type === 'input_audio_buffer.speech_started') {
      const stop = player.stopAll('speech_started')
      logger.log('play.stop', stop)
      setPhase('listening')
    } else if (type === 'input_audio_buffer.speech_stopped') {
      speechStoppedT = Date.now()
      setPhase('thinking')
    } else if (type === 'input_audio_buffer.committed') {
      onUserTranscript?.({ itemId: event.item_id, text: '', pending: true })
    } else if (type === 'conversation.item.input_audio_transcription.updated') {
      onUserTranscript?.({
        itemId: event.item_id,
        text: event.transcript || event.text || '',
        pending: false,
      })
    } else if (type === 'response.created') {
      createdT = Date.now()
      player.resetStats()
      player.resetTiming()
      responseAudio = null
      setPhase('thinking')
    } else if (type === 'response.output_audio_transcript.delta') {
      onAssistantTranscript?.({
        responseId: event.response_id,
        delta: event.delta || '',
        done: false,
      })
      setPhase('speaking')
    } else if (type === 'response.output_audio_transcript.done') {
      onAssistantTranscript?.({
        responseId: event.response_id,
        text: event.transcript || '',
        done: true,
      })
    } else if (type === 'response.done') {
      if (responseAudio) {
        const stats = player.getStats()
        logger.log('audio.out', {
          response_id: responseAudio.response_id,
          status: event.response?.status || event.status || 'ok',
          deltas: responseAudio.deltas,
          bytes: responseAudio.bytes,
          audio_ms: Math.round((responseAudio.bytes / 2 / TARGET_RATE) * 1000),
          wall_ms: Date.now() - responseAudio.started,
          max_gap_ms: responseAudio.maxGapMs,
          queued_ms: stats.queued_ms,
          underruns: stats.underruns,
          drain_ms_max: stats.drain_ms_max,
        })
      }
      responseAudio = null
      setPhase('listening')
    } else if (type === 'error') {
      const message = event.error?.message || event.message || 'Voice session error'
      onError?.(new Error(`${message} (voice session ${sessionId})`))
      logger.error('server', new Error(message), { type })
    }
  }

  logger.log('start', {
    url: 'wss://api.x.ai/v1/realtime?model=grok-voice-latest',
    target_rate: TARGET_RATE,
  })

  // Token + mic in parallel; buffer early audio until WS opens.
  const tokenStarted = performance.now()
  const tokenPromise = fetch('/api/voice/client-secret', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'X-Voice-Session-Id': sessionId },
  }).then(async (resp) => {
    const ms = Math.round(performance.now() - tokenStarted)
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}))
      const err = new Error(body.detail || `Token request failed (${resp.status})`)
      logger.error('token', err, { ms, status: resp.status })
      throw err
    }
    const data = await resp.json()
    logger.log('token.ok', { ms })
    return data
  })

  try {
    capture = await startMicCapture(audioContext, {
      targetRate: TARGET_RATE,
      onChunk: (chunk) => {
        noteAudioIn(chunk)
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          if (earlyChunks.length < EARLY_CAP) earlyChunks.push(chunk)
          return
        }
        sendClient({ type: 'input_audio_buffer.append', audio: chunk.base64 })
      },
    })
    logger.log('mic.ok', {
      ms: capture.ms,
      label: capture.label,
      settings: capture.settings,
    })
  } catch (err) {
    logger.error('mic', err)
    logger.close()
    try { await audioContext.close() } catch { /* ignore */ }
    throw err
  }

  let token
  try {
    token = await tokenPromise
  } catch (err) {
    capture.stop()
    logger.close()
    try { await audioContext.close() } catch { /* ignore */ }
    throw err
  }

  const wsUrl = token.ws_url || 'wss://api.x.ai/v1/realtime?model=grok-voice-latest'
  const secret = token.value
  const wsStarted = performance.now()
  logger.log('ws.connecting', { url: wsUrl })

  await new Promise((resolve, reject) => {
    try {
      ws = new WebSocket(wsUrl, [`xai-client-secret.${secret}`])
    } catch (err) {
      reject(err)
      return
    }
    ws.addEventListener('open', () => {
      logger.log('ws.open', { ms: Math.round(performance.now() - wsStarted) })
      resolve()
    })
    ws.addEventListener('error', () => {
      logger.log('ws.error', {})
      reject(new Error(`WebSocket failed (voice session ${sessionId})`))
    })
  })

  logger.log('env', {
    ua: navigator.userAgent,
    mic_rate: capture.micRate,
    mic_state: 'live',
    play_rate: audioContext.sampleRate,
    play_state: audioContext.state,
    capture_frames: Math.round(capture.micRate * 0.1),
    target_rate: TARGET_RATE,
  })

  ws.addEventListener('message', (ev) => {
    let event
    try {
      event = JSON.parse(String(ev.data))
    } catch {
      return
    }
    handleServerEvent(event)
  })

  ws.addEventListener('close', (ev) => {
    logger.log('ws.close', {
      code: ev.code,
      reason: ev.reason,
      wasClean: ev.wasClean,
      by: closed ? 'client' : 'server',
    })
    if (!closed) {
      onError?.(new Error(`Voice connection closed (voice session ${sessionId})`))
      setPhase('idle')
    }
  })

  sendClient({
    type: 'session.update',
    session: {
      voice,
      instructions,
      turn_detection: { type: 'server_vad' },
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: TARGET_RATE },
          transcription: { model: 'grok-transcribe' },
        },
        output: {
          format: { type: 'audio/pcm', rate: TARGET_RATE },
        },
      },
    },
  })
  flushEarly()

  const stop = async ({ by = 'client' } = {}) => {
    if (closed) return
    closed = true
    logger.log('stop', { by, phase })
    setPhase('idle')
    try { player.stopAll('client_stop') } catch { /* ignore */ }
    try { capture?.stop() } catch { /* ignore */ }
    try {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
    } catch { /* ignore */ }
    try { await audioContext.close() } catch { /* ignore */ }
    logger.close()
  }

  const sendText = (text) => {
    const clean = String(text || '').trim()
    if (!clean || !ws || ws.readyState !== WebSocket.OPEN) return false
    sendClient({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: clean }],
      },
    })
    sendClient({ type: 'response.create' })
    return true
  }

  return {
    sessionId,
    stop,
    sendText,
    getPhase: () => phase,
  }
}
