import { TARGET_RATE, base64ToInt16 } from './pcm'

/**
 * Schedule PCM16 base64 deltas on a shared AudioContext with a ~150 ms lead.
 * Barge-in clears everything queued.
 */
export function createPcmPlayer(audioContext, { rate = TARGET_RATE } = {}) {
  let nextTime = 0
  let leadArmed = false
  let underruns = 0
  let drainMsMax = 0
  let droppedMs = 0
  const sources = new Set()

  const resetTiming = () => {
    nextTime = 0
    leadArmed = false
  }

  const stopAll = (reason = 'barge-in') => {
    let remaining = 0
    if (nextTime > audioContext.currentTime) {
      remaining = (nextTime - audioContext.currentTime) * 1000
    }
    droppedMs += remaining
    for (const source of sources) {
      try { source.stop() } catch { /* already stopped */ }
      try { source.disconnect() } catch { /* ignore */ }
    }
    sources.clear()
    resetTiming()
    return { reason, dropped_ms: Math.round(remaining) }
  }

  const enqueueBase64 = (b64) => {
    const samples = base64ToInt16(b64)
    if (!samples.length) return { bytes: 0 }

    const float = new Float32Array(samples.length)
    for (let i = 0; i < samples.length; i += 1) {
      float[i] = samples[i] / 32768
    }
    const buffer = audioContext.createBuffer(1, float.length, rate)
    buffer.copyToChannel(float, 0)

    const source = audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(audioContext.destination)
    sources.add(source)
    source.onended = () => {
      sources.delete(source)
      try { source.disconnect() } catch { /* ignore */ }
    }

    const now = audioContext.currentTime
    if (!leadArmed) {
      nextTime = now + 0.15
      leadArmed = true
    } else if (nextTime < now) {
      underruns += 1
      const drain = (now - nextTime) * 1000
      if (drain > drainMsMax) drainMsMax = drain
      nextTime = now + 0.02
    }

    source.start(nextTime)
    nextTime += buffer.duration
    return { bytes: samples.byteLength }
  }

  return {
    enqueueBase64,
    stopAll,
    resetTiming,
    getStats() {
      return {
        underruns,
        drain_ms_max: Math.round(drainMsMax),
        dropped_ms: Math.round(droppedMs),
        play_state: audioContext.state,
        queued_ms: Math.max(0, Math.round((nextTime - audioContext.currentTime) * 1000)),
      }
    },
    resetStats() {
      underruns = 0
      drainMsMax = 0
      droppedMs = 0
    },
  }
}
