import './QrPlaceholder.css'

interface QrPlaceholderProps {
  /** Value the real QR would encode (e.g. join URL). Shown as caption only. */
  value?: string
  size?: number
}

/**
 * Front-end-only visual placeholder for a QR code.
 * Module 1 does not integrate a real QR generation service.
 * The pattern is decorative and purely illustrative.
 */
export function QrPlaceholder({ value, size = 180 }: QrPlaceholderProps) {
  return (
    <div className="qr-placeholder" style={{ width: size, height: size }}>
      <div className="qr-placeholder__grid" aria-hidden="true">
        {Array.from({ length: 36 }).map((_, i) => (
          <span
            key={i}
            className={`qr-cell ${(i * 7 + 3) % 3 === 0 ? 'qr-cell--on' : ''}`}
          />
        ))}
      </div>
      <span className="sr-only">
        QR code placeholder{value ? ` for ${value}` : ''}
      </span>
    </div>
  )
}
