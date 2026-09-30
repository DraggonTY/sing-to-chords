/** Encode the captured mono voice as a standard, uncompressed 16-bit WAV. */
export function encodeMonoWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  if (!Number.isInteger(sampleRate) || sampleRate < 1 || sampleRate > 384000) {
    throw new RangeError('Invalid recording sample rate.')
  }
  const dataLength = samples.length * 2
  if (dataLength > 0xffffffff - 36) throw new RangeError('Recording is too large for WAV.')
  const buffer = new ArrayBuffer(44 + dataLength)
  const view = new DataView(buffer)
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + dataLength, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, dataLength, true)
  for (let index = 0; index < samples.length; index++) {
    const value = Number.isFinite(samples[index]) ? Math.max(-1, Math.min(1, samples[index])) : 0
    view.setInt16(44 + index * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true)
  }
  return buffer
}
