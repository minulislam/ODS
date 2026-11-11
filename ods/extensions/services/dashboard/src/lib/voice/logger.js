/**
 * Dev-only Grok voice session logger.
 * Batches redacted events to POST /api/voice/log → server .voice-logs/<id>.ndjson.
 * Never throws into the voice path. Never logs tokens, keys, or raw audio.
 */

const AUDIO_EVENT_TYPES = new Set([
  'response.output_audio.delta',
  'response.audio.delta',
  'input_audio_buffer.append',
])

function b64Bytes(value) {
  if (typeof value !== 'string' || !value) return 0
  try {
    // atob length ≈ decoded bytes for standard base64 (padding aside).
    const pad = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor((value.length * 3) / 4) - pad)
  } catch {
    return value.length
  }
}

function truncateString(value) {
  if (typeof value !== 'string' || value.length <= 400) return value
  return `${value.slice(0, 400)}…[${value.length} chars]`
}

function redactValue(value, depth = 0) {
  if (depth > 4) return '[depth]'
  if (typeof value === 'string') return truncateString(value)
  if (Array.isArray(value)) {
    const clipped = value.slice(0, 50).map(item => redactValue(item, depth + 1))
    if (value.length > 50) clipped.push(`[+${value.length - 50} items]`)
    return clipped
  }
  if (value && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValue(child, depth + 1)
    }
    return out
  }
  return value
}

export function redactEvent(event) {
  if (!event || typeof event !== 'object') return event
  const type = event.type
  if (AUDIO_EVENT_TYPES.has(type)) {
    const bytes = b64Bytes(event.delta || event.audio || '')
    const copy = { ...event }
    delete copy.delta
    delete copy.audio
    copy.bytes = bytes
    return redactValue(copy)
  }
  return redactValue(event)
}

export function makeVoiceSessionId() {
  const uuid = globalThis.crypto?.randomUUID?.()
  if (uuid) return uuid.replace(/-/g, '').slice(0, 8)
  return Math.random().toString(16).slice(2, 10)
}

export function createVoiceLogger(sessionId, { sink = '/api/voice/log', enabled = true } = {}) {
  const buffer = []
  const started = Date.now()
  let timer = null
  let closed = false

  const scheduleFlush = () => {
    if (timer || closed || !enabled) return
    timer = setTimeout(() => {
      timer = null
      flush(false)
    }, 1000)
  }

  const log = (kind, data = {}) => {
    if (!enabled || closed) return
    const entry = {
      ...redactValue(data),
      t: Date.now() - started,
      ts: Date.now(),
      kind,
    }
    buffer.push(entry)
    if (import.meta.env?.DEV) {
      console.debug('[ods-voice]', entry)
    }
    if (buffer.length >= 200) {
      flush(false)
    } else {
      scheduleFlush()
    }
  }

  const flush = (final = false) => {
    if (!enabled) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (buffer.length === 0) return
    const entries = buffer.splice(0, buffer.length)
    const body = JSON.stringify({ sessionId, entries })
    try {
      if (final && typeof navigator !== 'undefined' && navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' })
        navigator.sendBeacon(sink, blob)
        return
      }
      fetch(sink, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body,
        keepalive: final,
      }).catch(() => {})
    } catch {
      // Logging must never throw into the voice path.
    }
  }

  return {
    sessionId,
    enabled,
    log,
    server(event, extra = {}) {
      if (AUDIO_EVENT_TYPES.has(event?.type)) return
      log('server', { ...redactEvent(event), ...extra })
    },
    client(event) {
      if (AUDIO_EVENT_TYPES.has(event?.type)) return
      log('client', redactEvent(event))
    },
    error(where, err, extra = {}) {
      log('error', {
        where,
        name: err?.name || 'Error',
        message: truncateString(String(err?.message || err || 'unknown')),
        ...extra,
      })
    },
    flush,
    close() {
      closed = true
      flush(true)
    },
  }
}
