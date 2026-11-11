/** PCM helpers for Grok realtime (16-bit LE mono). */

export const TARGET_RATE = 24000

export function floatTo16BitPCM(float32) {
  const out = new Int16Array(float32.length)
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]))
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return out
}

export function downsampleToRate(float32, inputRate, outputRate = TARGET_RATE) {
  if (inputRate === outputRate) return float32
  if (inputRate < outputRate) {
    // Rare up-sample path — linear interpolate.
    const ratio = inputRate / outputRate
    const newLen = Math.max(1, Math.round(float32.length / ratio))
    const result = new Float32Array(newLen)
    for (let i = 0; i < newLen; i += 1) {
      const src = i * ratio
      const idx = Math.floor(src)
      const frac = src - idx
      const a = float32[idx] || 0
      const b = float32[Math.min(idx + 1, float32.length - 1)] || 0
      result[i] = a + (b - a) * frac
    }
    return result
  }
  const ratio = inputRate / outputRate
  const newLen = Math.floor(float32.length / ratio)
  const result = new Float32Array(newLen)
  for (let i = 0; i < newLen; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.floor((i + 1) * ratio)
    let sum = 0
    let count = 0
    for (let j = start; j < end && j < float32.length; j += 1) {
      sum += float32[j]
      count += 1
    }
    result[i] = count ? sum / count : 0
  }
  return result
}

export function pcm16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToInt16(b64) {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  // Ensure even byte length for Int16 view.
  const even = bytes.byteLength & ~1
  return new Int16Array(bytes.buffer, bytes.byteOffset, even / 2)
}

export function rmsInt16(int16) {
  if (!int16.length) return 0
  let sum = 0
  for (let i = 0; i < int16.length; i += 1) {
    const n = int16[i] / 32768
    sum += n * n
  }
  return Math.sqrt(sum / int16.length)
}
