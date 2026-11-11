/**
 * Composer primary control for Grok voice mode.
 * Stroked waveform when idle; 4-bar animated waveform while live.
 * Never uses a microphone icon (reserved for dictation).
 */

const PHASE_MS = {
  listening: 900,
  speaking: 320,
  connecting: 1400,
  thinking: 1200,
  idle: 900,
}

function WaveformGlyph({ className = 'h-4 w-4' }) {
  // Stroked waveform (not a filled blob) so it stays legible at 16 px.
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 10v4" />
      <path d="M8 6v12" />
      <path d="M12 3v18" />
      <path d="M16 7v10" />
      <path d="M20 10v4" />
    </svg>
  )
}

function AnimatedBars({ phase = 'listening', reducedMotion = false }) {
  const period = PHASE_MS[phase] || PHASE_MS.listening
  const dimmed = phase === 'connecting' || phase === 'thinking'
  const bars = [0, 1, 2, 3]
  return (
    <span
      className="inline-flex h-4 items-end gap-0.5"
      style={{ opacity: dimmed ? 0.75 : 1 }}
      aria-hidden="true"
    >
      {bars.map(index => (
        <span
          key={index}
          className="inline-block w-[3px] rounded-sm bg-current"
          style={{
            height: 16,
            transformOrigin: 'bottom',
            transform: reducedMotion ? 'scaleY(0.7)' : undefined,
            animation: reducedMotion
              ? undefined
              : `ods-voice-bar ${period}ms ease-in-out ${index * (period / 6)}ms infinite alternate`,
            minHeight: 6,
          }}
        />
      ))}
      <style>{`
        @keyframes ods-voice-bar {
          from { transform: scaleY(0.4); }
          to { transform: scaleY(1); }
        }
      `}</style>
    </span>
  )
}

export default function VoiceWaveformButton({
  active = false,
  phase = 'idle',
  disabled = false,
  onClick,
  label,
}) {
  const reducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full disabled:opacity-40 ${
        active
          ? 'bg-zinc-950 text-white'
          : 'bg-zinc-100 text-zinc-700 hover:bg-zinc-200'
      }`}
      aria-label={label}
      title={label}
    >
      {active ? (
        <AnimatedBars phase={phase} reducedMotion={Boolean(reducedMotion)} />
      ) : (
        <WaveformGlyph />
      )}
    </button>
  )
}

export { WaveformGlyph, AnimatedBars }
