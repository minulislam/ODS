import { TARGET_RATE, downsampleToRate, floatTo16BitPCM, pcm16ToBase64, rmsInt16 } from './pcm'

const WORKLET_SOURCE = `
class OdsCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0] && inputs[0][0]
    if (input && input.length) {
      // Copy — the underlying buffer is reused by the audio thread.
      this.port.postMessage(input.slice(0))
    }
    return true
  }
}
registerProcessor('ods-capture', OdsCaptureProcessor)
`

/**
 * Mic capture into ~100 ms PCM16/24 kHz base64 chunks.
 * Uses one shared AudioContext created in the user gesture.
 */
export async function startMicCapture(audioContext, {
  onChunk,
  targetRate = TARGET_RATE,
} = {}) {
  const started = performance.now()
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  })
  const track = stream.getAudioTracks()[0]
  const settings = track?.getSettings?.() || {}
  const label = track?.label || 'default'

  const blob = new Blob([WORKLET_SOURCE], { type: 'application/javascript' })
  const moduleUrl = URL.createObjectURL(blob)
  try {
    await audioContext.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }

  const source = audioContext.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(audioContext, 'ods-capture')
  // Keep the graph alive without feeding mic into speakers.
  const mute = audioContext.createGain()
  mute.gain.value = 0
  source.connect(node)
  node.connect(mute)
  mute.connect(audioContext.destination)

  const micRate = audioContext.sampleRate
  const framesPerChunk = Math.max(1, Math.round(micRate * 0.1))
  let pending = new Float32Array(0)

  node.port.onmessage = (event) => {
    const frame = event.data
    if (!(frame instanceof Float32Array) || !frame.length) return
    const merged = new Float32Array(pending.length + frame.length)
    merged.set(pending, 0)
    merged.set(frame, pending.length)
    pending = merged
    while (pending.length >= framesPerChunk) {
      const slice = pending.subarray(0, framesPerChunk)
      pending = pending.subarray(framesPerChunk)
      const down = downsampleToRate(slice, micRate, targetRate)
      const pcm = floatTo16BitPCM(down)
      onChunk?.({
        base64: pcm16ToBase64(pcm),
        bytes: pcm.byteLength,
        rms: rmsInt16(pcm),
      })
    }
  }

  return {
    stream,
    label,
    settings,
    micRate,
    ms: Math.round(performance.now() - started),
    stop() {
      try { node.port.onmessage = null } catch { /* ignore */ }
      try { node.disconnect() } catch { /* ignore */ }
      try { source.disconnect() } catch { /* ignore */ }
      try { mute.disconnect() } catch { /* ignore */ }
      stream.getTracks().forEach(track => track.stop())
    },
  }
}
