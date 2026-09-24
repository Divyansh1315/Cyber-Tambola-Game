import type { HTMLAttributes, ReactNode } from 'react'
import './Card.css'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** Optional small uppercase heading shown at the top of the card. */
  title?: string
  children: ReactNode
}

/** Generic surface container used to group related content. */
export function Card({ title, children, className = '', ...rest }: CardProps) {
  return (
    <div className={`card ${className}`.trim()} {...rest}>
      {title != null && <h2 className="card__title">{title}</h2>}
      {children}
    </div>
  )
}
