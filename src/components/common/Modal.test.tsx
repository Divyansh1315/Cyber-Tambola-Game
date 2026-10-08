// Feature: player-ux-improvements — unit tests for Modal
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders nothing when open is false', () => {
    const { container } = render(
      <Modal open={false} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('renders role="dialog" and aria-modal="true" when open is true', () => {
    render(
      <Modal open aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    const dialog = screen.getByRole('dialog', { name: 'Test modal' })
    expect(dialog).toBeInTheDocument()
    expect(dialog).toHaveAttribute('aria-modal', 'true')
  })

  it('calls onDismiss when the backdrop is tapped and dismissable is true', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    const { container } = render(
      <Modal open dismissable onDismiss={onDismiss} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    const backdrop = container.querySelector('.modal__backdrop')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop as Element)

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('calls onDismiss when Escape is pressed and dismissable is true', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <Modal open dismissable onDismiss={onDismiss} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    await user.keyboard('{Escape}')

    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('does not call onDismiss on backdrop tap when dismissable is false', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    const { container } = render(
      <Modal open dismissable={false} onDismiss={onDismiss} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    const backdrop = container.querySelector('.modal__backdrop')
    expect(backdrop).not.toBeNull()
    await user.click(backdrop as Element)

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not call onDismiss on Escape when dismissable is false', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <Modal open dismissable={false} onDismiss={onDismiss} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    await user.keyboard('{Escape}')

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not click through to onDismiss when clicking inside the panel', async () => {
    const user = userEvent.setup()
    const onDismiss = vi.fn()
    render(
      <Modal open dismissable onDismiss={onDismiss} aria-label="Test modal">
        <p>Content</p>
      </Modal>,
    )

    await user.click(screen.getByText('Content'))

    expect(onDismiss).not.toHaveBeenCalled()
  })
})
