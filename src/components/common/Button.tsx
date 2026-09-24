import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './Button.css'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success'
type Size = 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Optional leading icon (text/emoji or node) rendered before the label. */
  icon?: ReactNode
  children: ReactNode
}

/**
 * Semantic, accessible button used across the prototype.
 * Uses a real <button> element so keyboard and focus behaviour work by default.
 */
export function Button({
  variant = 'primary',
  size = 'md',
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn--${variant} btn--${size} ${className}`.trim()}
      {...rest}
    >
      {icon != null && (
        <span className="btn__icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span>{children}</span>
    </button>
  )
}
