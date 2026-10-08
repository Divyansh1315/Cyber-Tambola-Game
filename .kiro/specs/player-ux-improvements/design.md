# Design Document

## Overview

This feature adds a UX layer on top of `PlayerGame.tsx`'s existing claim/prize machinery. No change is made to `prizeEngine.ts`, `winnerEngine.ts`, the reducer, `submit_claim`, realtime sync, or reconnect logic — those remain the single source of truth this design reads from.

The design introduces four new pieces, all additive:

1. **`PrizeClaimPopup`** — a new modal component shown automatically the instant a prize's `Player_Claim_Status` is `ELIGIBLE`, reusing `derivePlayerClaimStatus`, `claimStatusView`, `isSubmittingClaim`, and the existing `SUBMIT_PRIZE_CLAIM` dispatch verbatim.
2. **`useClaimPopupQueue`** — a new hook, owned by `PlayerGame.tsx`, that derives *which single* popup (if any) should be visible right now, purely as a function of the existing per-prize `status` list plus one small piece of session-only, in-memory UI state (the dismissed set). This hook is the only new "decision" logic in the feature; everything else is presentation.
3. **`CelebrationOverlay`** — a new transient overlay shown when a prize's status reaches `CONFIRMED`, auto-dismissing itself, honoring `prefers-reduced-motion`.
4. **`Modal`** — a new generic, reusable modal/bottom-sheet primitive in `src/components/common`, since none exists yet. `PrizeClaimPopup` is built on top of it.

Additionally, `TicketCell.tsx` gets one additive CSS hook for the diagonal strike — no markup is removed, no prop/behavior changes.

### Why a queue-derivation hook instead of ad-hoc state in PlayerGame.tsx

`PlayerGame.tsx` already computes `prizeBlocks` (one `{progress, status, view, ...}` per prize) on every render, purely derived from `state`. The popup system needs exactly one more derived value: "which one Prize_Id, if any, should have its popup open right now." Rather than scattering `useState`/`useEffect` calls across `PlayerGame.tsx`, this is isolated into one small hook (`useClaimPopupQueue`) so:

- The *only* piece of genuinely new client-side state is the in-memory dismissed-set (Requirement 4.4) and which Prize_Id is "currently presented" — both ephemeral, un-persisted, and reset on every mount/reload (satisfying Requirement 4.5's "no client-only persisted already-shown state" constraint).
- Popup visibility, ordering, and advancement are expressed as pure functions of `(statuses, dismissedSet, currentlyShownId)`, which is exactly what makes them property-testable (see Correctness Properties).

## Architecture

```mermaid
graph TD
    subgraph "Existing (unmodified)"
        A[prizeEngine.ts<br/>getAllPrizeProgress] --> B[GameSessionContext<br/>currentPrizeProgress, state.claims, state.winners, isSubmittingClaim]
        B --> C[winnerEngine.ts<br/>derivePlayerClaimStatus]
    end

    subgraph "PlayerGame.tsx (modified: wiring only)"
        C --> D[prizeBlocks<br/>existing per-prize status/view]
        D --> E[useClaimPopupQueue<br/>NEW hook]
        E --> F{activePopupPrizeId}
        D --> G["Claim Your Prizes" card<br/>existing, unchanged]
    end

    subgraph "New presentation components"
        F -->|renders at most one| H[PrizeClaimPopup]
        H --> I[Modal<br/>new generic primitive]
        D -->|status === CONFIRMED and not yet celebrated| J[CelebrationOverlay]
    end

    subgraph "TicketCell.tsx (modified: additive CSS hook)"
        K[Ticket_Cell MARKED] --> L[existing checkmark]
        K --> M[Diagonal_Strike<br/>NEW ::after, CSS only]
    end

    H -->|CLAIM PRIZE click| N[dispatch SUBMIT_PRIZE_CLAIM<br/>existing, unchanged]
    N --> B
```

**Key architectural rule carried through every component below:** nothing in `PrizeClaimPopup`, `useClaimPopupQueue`, or `CelebrationOverlay` ever re-derives eligibility, validation, or claim-decision logic. They only *read* `status` (the existing `PlayerClaimStatus`), `view` (the existing `claimStatusView` output), `isSubmittingClaim(prizeId)`, and `dispatch`.

## Components and Interfaces

### 1. `Modal` (new, `src/components/common/Modal.tsx`)

A generic, reusable, bottom-sheet-style modal, since the codebase has no modal primitive today (confirmed: no hits for "modal" or "dialog" in `src/components`). Minimal API, modeled after the existing `Card`/`Button` conventions (plain props, no portal library, no new dependency):

```tsx
interface ModalProps {
  /** Controls mount/unmount. Modal renders nothing when false. */
  open: boolean
  /** Called when the user dismisses via backdrop tap or close button. */
  onDismiss?: () => void
  /** If false, no close affordance is rendered and onDismiss is never wired to backdrop/Esc (used for the Celebration_Overlay's non-dismissable variant and for popups where dismissal has specific semantics). */
  dismissable?: boolean
  'aria-label': string
  children: ReactNode
}

export function Modal({ open, onDismiss, dismissable = true, children, ...rest }: ModalProps)
```

- Renders a fixed-position backdrop + a bottom-sheet-style panel (`position: fixed; inset: 0`, panel pinned to bottom, `max-width: 460px` centered — matching `.player__inner`), not a `<dialog>`/portal, since the whole app already renders inline (no portal root exists). Rendered directly inside `PlayerGame`'s tree where used, which also naturally keeps it under the Ticket's focus scope without extra wiring.
- Uses `role="dialog"` and `aria-modal="true"` for accessibility; traps no focus beyond what's needed (single primary button in practice) to keep this minimal.
- `Modal.css` follows the existing per-component CSS file convention (`Button.css`, `Card.css`).

### 2. `PrizeClaimPopup` (new, `src/components/player/PrizeClaimPopup.tsx`)

```tsx
interface PrizeClaimPopupProps {
  progress: PrizeProgress
  status: PlayerClaimStatus
  view: { message: string; buttonLabel: string; buttonDisabled: boolean }
  isSubmitting: boolean
  onClaim: () => void
  onDismiss: () => void
}

export function PrizeClaimPopup({ progress, status, view, isSubmitting, onClaim, onDismiss }: PrizeClaimPopupProps)
```

- Renders inside `Modal`. Title = `progress.label` (Req 1.2). Body message = `view.message` (reused verbatim from `claimStatusView`, satisfying Req 2.4's "same rejection message" and Req 1.4's "no new claim-decision logic").
- Primary button label = `isSubmitting ? 'Submitting Claim...' : view.buttonLabel`, `disabled={view.buttonDisabled || isSubmitting}` — identical derivation to the existing "Claim Your Prizes" card's button (Req 2.1, 2.2, 2.6), so the two surfaces can never disagree.
- `onClick` of the primary button calls `onClaim`, which `PlayerGame.tsx` wires to the exact same dispatch call already used by the card:
  ```tsx
  onClaim={() => dispatch({ type: 'SUBMIT_PRIZE_CLAIM', playerId: currentPlayer.id, ticketId: currentTicket.id, prizeId: progress.id })}
  ```
  (Req 1.3.) No new dispatch shape, no new action type.
- `Modal`'s `dismissable` is `true` only while `status === 'ELIGIBLE'` (a player can back out of an eligible-but-not-yet-claimed popup, Req 4.4); it is `false` while `status === 'PENDING'`/submitting (nothing meaningful to dismiss *to* — the card still shows the same pending state) and the popup instead auto-closes via the queue hook on `CONFIRMED`/`REJECTED`/`CLOSED_BY_OTHER_WINNER` transitions (Req 2.3, 2.5). On `REJECTED`, dismissal is allowed again (same `ELIGIBLE`-like resubmittable shape, Req 2.6).
- Does not itself contain any status-branching beyond what's needed to pick `dismissable` and button label — all message/label/disabled content comes from `view`.

### 3. `useClaimPopupQueue` (new hook, `src/hooks/useClaimPopupQueue.ts`)

This is the one piece of new decision logic. It is a pure function wrapped in a `useReducer`-backed hook so it can hold the small amount of session-only UI state (Requirement 4.4/4.5).

```ts
export interface ClaimPopupQueueInput {
  /** One entry per prize, in the exact order getAllPrizeProgress() already returns (Req 3.4). */
  prizeStatuses: { prizeId: PrizeId; status: PlayerClaimStatus }[]
}

export interface ClaimPopupQueueResult {
  /** The single Prize_Id whose popup should be visible right now, or undefined (Req 3.1, 3.2). */
  activePopupPrizeId: PrizeId | undefined
  /** Call when the player explicitly dismisses the currently-active popup while it is ELIGIBLE (Req 4.4). */
  dismissActivePopup: () => void
  /** The set of Prize_Ids that just transitioned into CONFIRMED and have not yet had their Celebration_Overlay shown (Req 2.3, 6.1). Consumed/cleared via acknowledgeCelebration. */
  pendingCelebrationPrizeId: PrizeId | undefined
  acknowledgeCelebration: (prizeId: PrizeId) => void
}

export function useClaimPopupQueue(input: ClaimPopupQueueInput): ClaimPopupQueueResult
```

**Pure derivation function** (the part that is property-tested directly, independent of React):

```ts
export function deriveActivePopup(
  prizeStatuses: { prizeId: PrizeId; status: PlayerClaimStatus }[],
  dismissedThisSession: ReadonlySet<PrizeId>,
  currentlyShown: PrizeId | undefined,
): PrizeId | undefined {
  // 1. If a popup is already showing and its status is still "poppable"
  //    (ELIGIBLE or PENDING-from-this-popup's-own-submission), keep showing it —
  //    this is what lets the loading/rejected states render in place rather
  //    than the popup flickering to a different prize mid-submission.
  const current = prizeStatuses.find((p) => p.prizeId === currentlyShown)
  if (current && (current.status === 'ELIGIBLE' || current.status === 'PENDING' || current.status === 'REJECTED')) {
    return currentlyShown
  }
  // 2. Otherwise pick the first ELIGIBLE, not-yet-dismissed-this-session
  //    prize, in prizeStatuses' own order (already PRIZES order per Req 3.4).
  return prizeStatuses.find(
    (p) => p.status === 'ELIGIBLE' && !dismissedThisSession.has(p.prizeId),
  )?.prizeId
}
```

- `dismissedThisSession` is a plain in-memory `Set<PrizeId>` held in `useState`/`useReducer` inside the hook — **never written to `localStorage`/`sessionStorage`**, so it is naturally cleared on reload/reconnect (Req 4.5). It only ever suppresses *automatic* re-popping of an `ELIGIBLE` prize the player already explicitly dismissed; it is never consulted by the existing "Claim Your Prizes" card, which stays fully independent (Req 1.5, 4.4).
- Celebration tracking (`pendingCelebrationPrizeId`) is derived the same way: the hook remembers the previous render's statuses (via a ref) and, when a prize's status transitions from anything else *to* `CONFIRMED`, flags it for one celebration; `acknowledgeCelebration` clears the flag once `CelebrationOverlay` finishes. This state is also in-memory only.
- Because `activePopupPrizeId` and `pendingCelebrationPrizeId` are mutually exclusive by construction (a `CONFIRMED` prize is never `ELIGIBLE`, so step 2 above can never select it, and step 1 only keeps a popup open for `ELIGIBLE`/`PENDING`/`REJECTED`), **a popup and the celebration overlay can never both be non-undefined at once** (Req 3.2).

### 4. `CelebrationOverlay` (new, `src/components/player/CelebrationOverlay.tsx`)

```tsx
interface CelebrationOverlayProps {
  prizeLabel: string
  onDismiss: () => void
  /** Overridable for tests; defaults to reading `matchMedia('(prefers-reduced-motion: reduce)')`. */
  reducedMotion?: boolean
}

export function CelebrationOverlay({ prizeLabel, onDismiss, reducedMotion }: CelebrationOverlayProps)
```

- Not built on `Modal` (it is non-dismissable by the user and must not trap interaction — Req 6.4), but visually layered the same way: a fixed-position container within `.player__inner`'s width.
- Reads `reducedMotion` via `window.matchMedia('(prefers-reduced-motion: reduce)').matches` by default (standard web API, no new dependency), overridable by prop for deterministic testing.
- **Animated branch** (`reducedMotion === false`): a small, dependency-free CSS-only confetti effect — a fixed number (e.g. 24) of absolutely-positioned `<span>` elements with staggered `animation-delay`, animated via CSS `@keyframes` (fall + fade), layered over a "🏆 {prizeLabel} confirmed!" message. No canvas, no animation library — keeps the dependency footprint at zero, consistent with `package.json`'s current dependency set (no animation libs present).
- **Reduced-motion branch**: renders the identical "🏆 {prizeLabel} confirmed!" message with no animated spans and no `@keyframes`-driven elements — same confirmed-win information, Req 6.6.
- Auto-dismiss: a `useEffect` with `setTimeout(onDismiss, CELEBRATION_DURATION_MS)` (constant, e.g. 3000ms), cleared on unmount. `onDismiss` is `acknowledgeCelebration(prizeId)` from the queue hook, which unmounts `CelebrationOverlay` entirely — satisfying Req 6.5 ("remove every DOM element it added") by construction, since conditional rendering (`{pendingCelebrationPrizeId && <CelebrationOverlay .../>}`) removes the whole subtree.
- Rendered with `pointer-events: none` on the decorative confetti spans (not the dismiss timer) so the ticket beneath remains tappable while the overlay is visible (Req 6.4) — the overlay itself does not cover the full ticket, only a banner-style region, so Requirement 6.4's "remain usable" holds without needing to special-case pointer-events on the whole overlay.

### 5. `PlayerGame.tsx` (modified: wiring only)

Changes are additive and localized:

```tsx
const popupQueue = useClaimPopupQueue({
  prizeStatuses: prizeBlocks.map((b) => ({ prizeId: b.progress.id, status: b.status })),
})

const activeBlock = prizeBlocks.find((b) => b.progress.id === popupQueue.activePopupPrizeId)
const celebratingBlock = prizeBlocks.find((b) => b.progress.id === popupQueue.pendingCelebrationPrizeId)
```

- `activeBlock` (if any) renders one `<PrizeClaimPopup>` using that block's existing `progress`/`status`/`view`/`isSubmitting`, wired to the existing dispatch and to `popupQueue.dismissActivePopup`.
- `celebratingBlock` (if any) renders one `<CelebrationOverlay prizeLabel={celebratingBlock.progress.label} onDismiss={() => popupQueue.acknowledgeCelebration(celebratingBlock.progress.id)} />`.
- Both are rendered as siblings near the top of `.player__inner`'s JSX (position is irrelevant since both use `position: fixed`), **after** the existing "Claim Your Prizes" card's JSX in source order so they are both still inside the component but visually overlay everything — the card itself is untouched (Req 1.5).
- No other change to `PlayerGame.tsx`'s existing logic, state, or the `prizeBlocks` derivation.

### 6. `TicketCell.tsx` (modified: additive CSS hook only)

```tsx
<button
  type="button"
  className={`ticket-cell ${isMarked ? 'ticket-cell--marked' : 'ticket-cell--unmarked'}`}
  ...
>
  {cell.state === 'MARKED' && (
    <span className="ticket-cell__icon" aria-hidden="true">{STATE_META.MARKED.icon}</span>
  )}
  <span className="ticket-cell__term">{cell.term}</span>
</button>
```

No JSX change is actually required: `.ticket-cell--marked` already exists as a class on exactly the cells this feature needs to target. The diagonal strike is added **purely in `Ticket.css`**, as a `::after` pseudo-element scoped to `.ticket-cell--marked`:

```css
.ticket-cell--marked {
  position: relative; /* establishes the containing block for ::after, Req 5.4 */
}

.ticket-cell--marked::after {
  content: '';
  position: absolute;
  left: 6%;
  right: 6%;
  top: 50%;
  height: 2px;
  background: var(--color-accent-strong);
  transform: translateY(-50%) rotate(-18deg);
  pointer-events: none; /* never intercepts the cell's own click (Req 5.1 additive, not replacing tap behavior) */
}
```

- `position: relative` + percentage-based `left`/`right` keep the strike confined to the cell's own box at any width, including `.player__inner`'s 460px mobile frame (Req 5.4, 7.3) — no fixed pixel widths that could overflow on narrow phones.
- `pointer-events: none` and `content: ''` on a pseudo-element mean `.ticket-cell__term`'s actual text node is never touched, removed, or covered by a sibling DOM node (Req 5.2) — it is a thin line layered via `z-index`-free stacking (the pseudo-element paints after the text in the same stacking context, but at 2px tall and translated to the vertical center it does not visually cover full glyph height for the term font sizes in `Ticket.css`, satisfying Req 5.3 at the component level; final visual confirmation is manual, see Testing Strategy).
- Rendered only when `.ticket-cell--marked` is present, i.e. exactly when `cell.state === 'MARKED'` — never for `--unmarked` (Req 5.5), with zero new JSX/props.

## Data Models

No new persisted data model. Two new, purely client-side, in-memory (never serialized, never sent to Supabase) shapes:

```ts
/** Owned entirely inside useClaimPopupQueue's internal state; never exported raw. */
interface ClaimPopupQueueState {
  /** Prize_Ids the player explicitly dismissed this session while ELIGIBLE (Req 4.4). Plain Set, in-memory only. */
  dismissedThisSession: Set<PrizeId>
  /** The Prize_Id whose popup is currently being shown, if any (lets the hook keep showing the same popup through PENDING/REJECTED transitions). */
  currentlyShown: PrizeId | undefined
  /** The previous render's status-per-prize snapshot, used to detect a fresh transition into CONFIRMED (so celebration fires once, not on every re-render while CONFIRMED). */
  previousStatuses: Map<PrizeId, PlayerClaimStatus>
  /** The Prize_Id currently flagged for its one-time Celebration_Overlay, if any. */
  pendingCelebrationPrizeId: PrizeId | undefined
}
```

All fields reset to their initial empty values on every mount (component remount = page reload = new game session tab), which is exactly the desired behavior per Requirement 4.5 — there is no `localStorage`/`sessionStorage` write anywhere in this feature.

No change to `PrizeProgress`, `PlayerClaimStatus`, `PrizeClaim`, or `Winner` (all reused verbatim from `src/types/prize.ts` and `winnerEngine.ts`).

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

The queue-derivation logic (`deriveActivePopup` and its celebration-tracking counterpart) is a pure function over small enumerable input spaces (5 `PrizeId`s × 6 `PlayerClaimStatus` values × a boolean dismissed-set × an optional "currently shown" id), making it an ideal target for property-based testing with `fast-check` (already a devDependency). `PrizeClaimPopup`'s and `TicketCell`'s rendering are likewise pure functions of their props, suitable for property tests over randomized prop combinations. Visual/layout concerns (strike confinement at a given CSS width, "readability," overlay rendering within 460px) are **not** modeled as properties — they require manual/visual review and are called out explicitly in Testing Strategy instead.

### Property 1: Exactly one eligible-and-not-dismissed prize's popup is shown, in PRIZES order

*For any* list of `(prizeId, status)` pairs covering any subset of the five `PrizeId`s in any status, and *for any* dismissed-set and currently-shown value, `deriveActivePopup` returns either `undefined` or a `prizeId` whose status is `ELIGIBLE`, `PENDING`, or `REJECTED` — and when it falls through to picking a fresh prize (no eligible "currently shown" carried over), it returns the *first* prize in the input's own order whose status is `ELIGIBLE` and which is not in the dismissed-set, matching the order `getAllPrizeProgress()` already produces.

**Validates: Requirements 1.1, 3.1, 3.4, 4.1, 4.2, 4.3**

### Property 2: Popup and Celebration overlay are mutually exclusive

*For any* sequence of status-list snapshots fed into the queue hook across successive renders, at no point are both `activePopupPrizeId` and `pendingCelebrationPrizeId` simultaneously defined.

**Validates: Requirements 3.2**

### Property 3: Closing the current popup advances to the next still-eligible queued prize, or to none

*For any* set of `PrizeId`s with `ELIGIBLE` status and a currently-shown prize among them, simulating that popup's closure (by changing its status away from `ELIGIBLE`/`PENDING`/`REJECTED`, or by dismissing it) causes the next call to `deriveActivePopup` to return the next remaining `ELIGIBLE`, not-dismissed prize in `PRIZES` order, or `undefined` if none remain.

**Validates: Requirements 3.3**

### Property 4: Dismissing an eligible popup suppresses it for the rest of the session but never touches other prizes or the manual claim card

*For any* `PrizeId` dismissed while its status is `ELIGIBLE`, every subsequent call to `deriveActivePopup` with that same `prizeId` still `ELIGIBLE` and still in the dismissed-set never returns that `prizeId`, while any *other* `PrizeId` that independently becomes `ELIGIBLE` is unaffected by that dismissal and can still be returned.

**Validates: Requirements 4.4**

### Property 5: A CONFIRMED transition is flagged for celebration exactly once

*For any* sequence of status snapshots in which a given `prizeId`'s status changes from a non-`CONFIRMED` value to `CONFIRMED` and then stays `CONFIRMED` across further renders, the queue hook flags that `prizeId` as `pendingCelebrationPrizeId` on the render where the transition is first observed, and does not re-flag it again on subsequent renders while it remains `CONFIRMED` (until `acknowledgeCelebration` is called and a *new* transition could occur only for a different prize, since a prize cannot leave `CONFIRMED` once reached).

**Validates: Requirements 2.3, 6.1, 6.2**

### Property 6: Popup content and button state are a pure function of status, progress, and submission flag

*For any* `PrizeProgress`, `PlayerClaimStatus`, `claimStatusView` output, and `isSubmitting` boolean, `PrizeClaimPopup`'s rendered title equals `progress.label`, its rendered message equals the given `view.message` verbatim, and its primary button is disabled if and only if `view.buttonDisabled || isSubmitting` — identical to the derivation already used by the existing "Claim Your Prizes" card.

**Validates: Requirements 1.2, 2.1, 2.4, 2.6**

### Property 7: Claiming always dispatches the exact existing action shape, exactly once per enabled click

*For any* `playerId`, `ticketId`, and `prizeId`, activating `PrizeClaimPopup`'s primary button while it is enabled calls the provided `onClaim` exactly once per click, and `PlayerGame.tsx`'s wiring of `onClaim` issues `dispatch({ type: 'SUBMIT_PRIZE_CLAIM', playerId, ticketId, prizeId })` with no additional fields; activating it while disabled (per Property 6) never calls `onClaim`.

**Validates: Requirements 1.3, 2.2**

### Property 8: The diagonal strike CSS hook is present if and only if the cell is MARKED, and term text is always preserved

*For any* `TicketCellData` (any `termId`/`term`/`state`), `TicketCell`'s rendered root `className` includes `ticket-cell--marked` if and only if `cell.state === 'MARKED'`, the existing checkmark icon is present if and only if `cell.state === 'MARKED'`, and the rendered `.ticket-cell__term` text content always equals `cell.term` exactly, regardless of state.

**Validates: Requirements 5.1, 5.2, 5.5**

### Property 9: Celebration overlay shows identical confirmed-win information under both motion preferences

*For any* `prizeLabel` string and boolean `reducedMotion` value, `CelebrationOverlay`'s rendered text content includes `prizeLabel`'s confirmed-win message in both branches, and the animated confetti elements are rendered if and only if `reducedMotion` is `false`.

**Validates: Requirements 6.6**

## Error Handling

This feature introduces no new error states of its own — it has no network calls, no validation, and no new failure modes beyond what `SUBMIT_PRIZE_CLAIM`'s existing dispatch path already handles (rollback on RPC rejection, `REJECTED` status, `lastSessionGuardFailure`). Specifically:

- **Claim rejected mid-popup**: handled entirely by reading `status === 'REJECTED'` and `view.message` (Req 2.4) — no new error branch.
- **Session guard failure while a popup is open** (`lastSessionGuardFailure.prizeId === progress.id`, existing mechanism): `PlayerGame.tsx`'s existing card already special-cases this with a "Refresh" prompt. `PrizeClaimPopup` is given the same `sessionGuardFailed` boolean already computed in `prizeBlocks` and renders the identical "session out of date, refresh" message/button in place of the claim button when true, rather than inventing a second messaging path.
- **Component unmounts mid-flight** (e.g. player navigates away while `isSubmittingClaim` is true): no cleanup needed beyond React's own unmount — `isSubmittingClaim` lives in `GameSessionContext`, not in these components, so it is unaffected by `PrizeClaimPopup` unmounting.
- **`matchMedia` unavailable** (older/non-standard environment): `CelebrationOverlay` guards the read with `typeof window.matchMedia === 'function'`, defaulting `reducedMotion` to `false` (animated branch) if the API is absent, so the overlay never throws.
- **Multiple prizes reaching `ELIGIBLE`/`CONFIRMED` in the same render** (e.g. a single mark completes two line prizes at once): fully covered by `deriveActivePopup`'s deterministic ordering (Property 1) and the celebration flag being keyed per-`prizeId` (Property 5) — no race, since this is a pure synchronous derivation from one render's status snapshot, not an async operation.

## Testing Strategy

**Property-based tests** (Properties 1-9 above), using `fast-check` (already a devDependency, consistent with the rest of the codebase's testing conventions seen in `*.integration.test.tsx`/`*.test.tsx` files), each configured for a minimum of 100 iterations and tagged with its design property:

- Generators needed: arbitrary subsets/orderings of the 5 `PrizeId`s, arbitrary `PlayerClaimStatus` values, arbitrary status-sequences (for transition properties 3 and 5), arbitrary `PrizeProgress`/`view` shapes, arbitrary strings for `prizeLabel`/`term`.
- Each property test imports and calls the real exported pure functions (`deriveActivePopup` and the hook's celebration-tracking logic extracted similarly, or exercised via `@testing-library/react`'s `renderHook`) and the real `PrizeClaimPopup`/`TicketCell`/`CelebrationOverlay` components via `@testing-library/react`, matching the existing test style (`PrizeProgressList.test.tsx`, `ClaimStatusTag.test.tsx`, `Ticket.test.tsx`).
- Tag format in each test file: `// Feature: player-ux-improvements, Property N: <property text>`.

**Unit/example tests** (not property-based, per the decision guide — fixed single scenarios, not varying meaningfully with input):

- Req 2.7 / 6.4 (ticket remains tappable while popup/overlay is open): render `PrizeGame`'s relevant subtree with a popup/overlay mounted, fire one tap on a `TicketCell`, assert the tap's `onToggle` still fires.
- Req 6.3 (auto-dismiss timing) and Req 6.5 (DOM cleanup on dismiss): mount `CelebrationOverlay` with fake timers (`vi.useFakeTimers()`, consistent with existing Vitest setup), advance exactly the configured duration, assert `onDismiss` fired and (when wired through `PlayerGame`'s conditional render) the overlay's container is no longer in the DOM.
- `Modal` basic behavior: open/closed render, backdrop/Esc dismissal only when `dismissable`, `role="dialog"`/`aria-modal` present.
- Error-handling branch: session-guard-failed rendering inside `PrizeClaimPopup` (one fixed scenario, mirroring the existing card's own test coverage pattern if any exists, otherwise a new focused test).

**Not covered by automated tests — explicitly manual/visual review** (per Requirements 5.3, 5.4, 7.1-7.4, 6.7, which are visual/layout concerns not expressible as jsdom assertions):
- Diagonal strike legibility across the longest terms in the term bank, at 460px and wider.
- Popup and celebration overlay fitting within `.player__inner` at common smartphone viewport heights without the CLAIM PRIZE button being pushed off-screen.
- No horizontal scroll introduced by the overlay/popup at mobile widths.

These are called out to the user as required manual checks before merge, consistent with this design's note in Error Handling / Testing Strategy that visual qualities are not property-testable.

**Preservation**: no existing test file for `prizeEngine.ts`, `winnerEngine.ts`, the reducer, or the existing "Claim Your Prizes" card's rendering is modified by this feature — those continue to pass unchanged, confirming Requirement 8's "UX layer only" constraint is upheld in practice, not just by design intent.

---

## Addendum: Requirements 10-12 (Post-Implementation Refinements)

Requirements 1-9 above are already implemented and merged. This addendum covers three refinements made on top of that already-shipped code, discovered during further live gameplay testing: a color correction to the existing Diagonal_Strike (Req 10), a stronger Celebration_Overlay effect (Req 11), and a new Awarded_Cell_Overlay for ticket cells belonging to an already-won Fixed_Pattern_Prize (Req 12). As with Requirements 1-9, no ticket generation, reveal, marking, prize-eligibility, claim-validation, sync, reconnect, or host-control logic is touched — all three refinements are presentation-only, reading from already-authoritative state (`state.winners`) or tuning already-isolated CSS/constants.

### Addendum Architecture

```mermaid
graph TD
    subgraph "Existing (unmodified)"
        A2[prizeEngine.ts<br/>PRIZES, LINE_PRIZE_ROWS] 
        W[state.winners<br/>synced, authoritative]
    end

    subgraph "prizeEngine.ts (modified: one new pure function)"
        A2 --> GAT[getAwardedCellTermIds<br/>NEW pure function]
        W --> GAT
    end

    subgraph "PlayerGame.tsx (modified: wiring only)"
        GAT --> AT[awardedTermIds: Set&lt;string&gt;<br/>computed once per render]
        AT --> TK[Ticket<br/>awardedTermIds prop]
    end

    subgraph "Ticket.tsx (modified: prop threading only)"
        TK --> TC[TicketCell<br/>isAwarded prop, per cell]
    end

    subgraph "TicketCell.tsx (modified: additive CSS hook)"
        TC --> CLS["ticket-cell--awarded class<br/>(additive to --marked)"]
    end

    subgraph "Ticket.css (modified: 1 value + 1 new rule block)"
        FIX["::after background:<br/>var(--color-accent-strong) → var(--color-ink)"]
        NEW[".ticket-cell--awarded<br/>grey background, NEW"]
    end

    subgraph "CelebrationOverlay.tsx/css (modified: constants only)"
        TUNE["CONFETTI_COUNT 24→56<br/>piece size/color variety ↑<br/>trigger/dismiss/reduced-motion UNCHANGED"]
    end
```

### 1. `prizeEngine.ts`: `getAwardedCellTermIds` (new pure function)

A new, exported, pure derivation function, co-located with `getAllPrizeProgress` and the other derivation functions already in this file. It reuses `PRIZES` and the existing `LINE_PRIZE_ROWS` row-index mapping internally rather than duplicating the row-to-prize relationship anywhere else (Req 12.2).

```ts
/** The four Fixed_Pattern_Prizes with a determinable, fixed cell set (Req 12). CYBER_FIVE is deliberately excluded — it has no fixed cell set (Req 12.3). */
const FIXED_PATTERN_PRIZE_IDS = [
  'FIREWALL_LINE',
  'SECURITY_LINE',
  'DATA_DEFENDER_LINE',
  'CYBER_FULL_HOUSE',
] as const

/**
 * The termIds of every Ticket_Cell belonging to a Fixed_Pattern_Prize this
 * player has an Awarded_Prize_Pattern for, on this ticket, in this game
 * (Req 12.1, 12.2, 12.4, 12.7, 12.8). CYBER_FIVE never contributes termIds
 * (Req 12.3). A Winner belonging to a different player or a different game
 * never contributes termIds (Req 12.5 is handled naturally: callers pass
 * only `winners` already scoped to `state.winners`, and this function
 * itself re-checks `w.gameId === gameId` and `w.playerId === playerId`, so
 * a CLOSED_BY_OTHER_WINNER record for this exact prize/game is excluded by
 * construction). Never mutates `ticket` or `winners`. A termId belonging to
 * more than one awarded prize's cell set (e.g. a row cell that's also part
 * of an awarded CYBER_FULL_HOUSE) is naturally de-duplicated by `Set`
 * semantics (Req 12.7).
 */
export function getAwardedCellTermIds(
  ticket: Ticket,
  winners: readonly Winner[],
  playerId: string,
  gameId: string,
): Set<string> {
  const result = new Set<string>()

  for (const prizeId of FIXED_PATTERN_PRIZE_IDS) {
    const won = winners.some(
      (w) => w.gameId === gameId && w.playerId === playerId && w.prizeId === prizeId,
    )
    if (!won) continue

    const cells =
      prizeId === 'CYBER_FULL_HOUSE'
        ? ticket.rows.flat()
        : ticket.rows[LINE_PRIZE_ROWS[prizeId]] ?? []

    for (const cell of cells) {
      result.add(cell.termId)
    }
  }

  return result
}
```

- `LINE_PRIZE_ROWS` is currently a module-private `const` in `prizeEngine.ts`. It is exported (adding `export` to its existing declaration) so this function can reuse it directly rather than re-declaring the row mapping — satisfying Req 12.2's "introducing no new row-to-prize mapping" literally, not just in spirit. No change to its three existing key/value pairs.
- `Winner` is imported from `../types/prize` (already imported elsewhere in the codebase; `prizeEngine.ts` currently imports `Prize, PrizeProgress` from the same module — `Winner` is added to that same import).
- Signature intentionally mirrors `getPlayerTicketMarks`'s existing `(ticket-or-marks, ..., playerId, ticketId/gameId)` parameter ordering convention already used in this file.

### 2. `PlayerGame.tsx`: wiring (modified)

One new derived value, computed alongside the existing `renderedTicket`/`prizeBlocks` derivations, using the same `useMemo` convention already used for `renderedTicket`:

```tsx
const awardedTermIds = useMemo(
  () =>
    currentTicket
      ? getAwardedCellTermIds(currentTicket, state.winners, currentPlayer?.id ?? '', state.game.id)
      : new Set<string>(),
  [currentTicket, state.winners, currentPlayer, state.game.id],
)
```

- Placed after the existing redirect guard (so `currentPlayer`/`currentTicket` are known non-null at the point `<Ticket>` is actually rendered), consistent with where `prizeBlocks` is already computed in this file.
- Passed straight through to `<Ticket>`:
  ```tsx
  <Ticket ticket={renderedTicket} onToggleCell={handleTap} awardedTermIds={awardedTermIds} />
  ```
- No other change to `PlayerGame.tsx`'s existing logic, `prizeBlocks`, popup/celebration wiring, or JSX ordering from Requirements 1-9.

### 3. `Ticket.tsx`: prop threading (modified)

`Ticket` receives the whole `awardedTermIds` set (rather than Ticket.tsx trying to pre-compute per-row booleans) and does the one-line `.has()` lookup per cell at render time, keeping `getAwardedCellTermIds` itself free of any rendering concerns:

```tsx
interface TicketProps {
  ticket: TicketData
  onToggleCell: (termId: string) => void
  /** termIds whose Ticket_Cell belongs to an already-awarded Fixed_Pattern_Prize for the current player (Req 12). Empty set when none. */
  awardedTermIds: ReadonlySet<string>
}

export function Ticket({ ticket, onToggleCell, awardedTermIds }: TicketProps) {
  return (
    <div className="ticket-grid" role="grid" aria-label={`Cyber word ticket ${ticket.ref}`}>
      {ticket.rows.map((row, rowIndex) => (
        <div className="ticket-grid__row" role="row" key={rowIndex}>
          {row.map((cell) => (
            <div role="gridcell" key={cell.termId}>
              <TicketCell
                cell={cell}
                onToggle={onToggleCell}
                isAwarded={awardedTermIds.has(cell.termId)}
              />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
```

### 4. `TicketCell.tsx`: additive prop + CSS hook (modified)

```tsx
interface TicketCellProps {
  cell: TicketCellData
  onToggle: (termId: string) => void
  /** Whether this cell belongs to a Fixed_Pattern_Prize already won by the current player (Req 12). Defaults to false so existing callers/tests without the prop are unaffected. */
  isAwarded?: boolean
}

export function TicketCell({ cell, onToggle, isAwarded = false }: TicketCellProps) {
  const meta = STATE_META[cell.state]
  const isMarked = cell.state === 'MARKED'

  return (
    <button
      type="button"
      className={[
        'ticket-cell',
        isMarked ? 'ticket-cell--marked' : 'ticket-cell--unmarked',
        isAwarded ? 'ticket-cell--awarded' : '',
      ].filter(Boolean).join(' ')}
      onClick={() => onToggle(cell.termId)}
      aria-pressed={isMarked}
      aria-label={`${cell.term}. ${meta.hint}`}
    >
      {cell.state === 'MARKED' && (
        <span className="ticket-cell__icon" aria-hidden="true">{STATE_META.MARKED.icon}</span>
      )}
      <span className="ticket-cell__term">{cell.term}</span>
    </button>
  )
}
```

- `isAwarded` defaults to `false` so every existing call site/test that doesn't pass it (if any remain, e.g. isolated `TicketCell` unit tests) continues to render exactly as before (Req 12.8's "preserving the existing checkmark icon and the Diagonal_Strike" — neither is removed or conditioned on `isAwarded`).
- `ticket-cell--awarded` is additive: it can co-occur with `ticket-cell--marked` (in practice it always will, since Req 12.6 guarantees an awarded prize's cells are only greyed while the player's own claim for that prize is `CONFIRMED`, which requires those cells to already be `MARKED`), but the className logic itself does not enforce that pairing — it is a pure function of `cell.state`/`isAwarded` independently, matching Property 10 below.
- No change to `onToggle`/`aria-label`/`aria-pressed` behavior — a cell belonging to an awarded prize remains exactly as tappable/no-op as any other `MARKED` cell (tapping an already-`MARKED` cell is already a no-op per `handleTap` in `PlayerGame.tsx`, unchanged by this feature).

### 5. CSS changes

**Requirement 10 — diagonal strike color fix** (`Ticket.css`, one value changed):

```css
.ticket-cell--marked::after {
  content: '';
  position: absolute;
  left: 6%;
  right: 6%;
  top: 50%;
  height: 2px;
  background: var(--color-ink); /* was var(--color-accent-strong); Req 10.1 */
  transform: translateY(-50%) rotate(-18deg);
  pointer-events: none;
}
```

`--color-ink` (`#0b1a2b`, defined in `global.css`) is reused rather than introducing a new variable — it is the codebase's existing dark/near-black text-ink token, already used for primary text color everywhere else (`BrandMark.css`, `CyberWordCard.css`, `HostDashboard.css`, etc.), so no new CSS variable is added. No other property on this rule changes — same `height: 2px`, same `position`/`transform`, same single line (Req 10.2). Since `--color-ink` (`#0b1a2b`) is darker than the previous `--color-accent-strong` (`#0c8f6a`) and still a thin 2px line, it remains no more visually obscuring of `.ticket-cell__term` than before (Req 10.3). The `cell.state !== 'MARKED'` branch is untouched — the selector is still scoped to `.ticket-cell--marked::after` only (Req 10.4).

**Requirement 12 — awarded cell greying** (`Ticket.css`, new rule block + two new state tokens in `global.css`):

Two new state-color tokens are added to `global.css`'s existing "State colors for ticket / status" block, following that block's exact existing naming convention (`--state-{name}-bg` / `--state-{name}-ink`):

```css
/* global.css, appended to the existing State colors block */
--state-awarded-bg: #cbd5e1;   /* neutral grey, distinct from locked/available/marked */
--state-awarded-ink: #334155;  /* dark enough on grey for AA body-text contrast */
```

```css
/* Ticket.css */
.ticket-cell--awarded {
  background: var(--state-awarded-bg);
  border-color: var(--state-awarded-ink);
  color: var(--state-awarded-ink);
}
```

- This rule is declared **after** `.ticket-cell--marked` in the stylesheet (and `.ticket-cell--awarded` always co-occurs with `.ticket-cell--marked` per the design note above), so its `background`/`border-color`/`color` values win over `.ticket-cell--marked`'s own `background: var(--state-marked-bg)` / `border-color: var(--color-accent-strong)` / `color: var(--state-marked-ink)` via normal CSS source-order cascade (both selectors have equal specificity — one class each) — no `!important` needed.
- The existing `.ticket-cell--marked::after` diagonal strike rule is unaffected by this new rule (different pseudo-element, not overridden), so the now-dark-ink strike (Req 10) remains rendered on top of the grey background, satisfying Req 12.8's "preserving... the Diagonal_Strike."
- The existing checkmark icon (`.ticket-cell__icon`, inline in the JSX, not styled by color at all) is likewise untouched — satisfying the rest of Req 12.8.
- Contrast: `--state-awarded-ink` (`#334155`) on `--state-awarded-bg` (`#cbd5e1`) yields a contrast ratio of ~5.2:1, exceeding WCAG AA's 4.5:1 for normal text — at least as readable as `.ticket-cell--marked`'s own existing `--state-marked-ink` (`#ffffff`) on `--state-marked-bg` (`#0c8f6a`, ~4.7:1), satisfying Req 12.9's "SHALL NOT reduce the readability... below the existing contrast provided for a MARKED, non-awarded Ticket_Cell." (Note: full WCAG conformance also requires manual verification with assistive technology, per this workflow's standing guidance — the ratio above is a calculated contribution to that review, not a substitute for it.)

**Requirement 11 — stronger celebration effect** (`CelebrationOverlay.tsx` / `CelebrationOverlay.css`, constants and CSS only):

```tsx
// CelebrationOverlay.tsx
export const CELEBRATION_DURATION_MS = 3000 // UNCHANGED (Req 11.4)
const CONFETTI_COUNT = 56 // was 24 (Req 11.1)
```

```css
/* CelebrationOverlay.css */
.celebration-overlay__piece {
  position: absolute;
  top: -12px;
  width: 10px;   /* was 8px */
  height: 16px;  /* was 14px */
  pointer-events: none;
  animation: celebration-overlay-fall 1.6s linear infinite; /* was 1.8s, slightly snappier for a "burst" feel */
}

/* was 2 colors via :nth-child(3n)/(3n+1); now 4 for more variety/brightness (Req 11.1) */
.celebration-overlay__piece:nth-child(4n) {
  background: var(--color-primary);
}
.celebration-overlay__piece:nth-child(4n + 1) {
  background: var(--color-warning);
}
.celebration-overlay__piece:nth-child(4n + 2) {
  background: var(--color-accent);
}
.celebration-overlay__piece:nth-child(4n + 3) {
  background: var(--color-danger);
}
```

- `CONFETTI_COUNT` increasing from 24 to 56 only changes `Array.from({ length: CONFETTI_COUNT }, ...)`'s loop bound in the existing render — no new JSX structure, no new conditional branch (Req 11.2: CSS/constants only, no new runtime dependency).
- The existing `left: ${(index * (100 / CONFETTI_COUNT)) % 100}%` and `animationDelay: ${(index % 8) * 0.15}s` expressions in the component are untouched and automatically re-space themselves correctly for the new count (both are already functions of `CONFETTI_COUNT`/`index`, not hardcoded) — a wider spread of start positions plus the existing stagger is what produces the "burst" feel, with no new animation code required.
- `reducedMotion`, the `useEffect(() => setTimeout(onDismiss, CELEBRATION_DURATION_MS), ...)` auto-dismiss, and the conditional-render-based DOM cleanup are all **unchanged** — satisfying Req 11.3 (trigger condition unchanged), Req 11.4 (dismiss timing + cleanup unchanged), and Req 11.5 (reduced-motion branch unchanged; it never rendered confetti spans and still doesn't).
- `useClaimPopupQueue`'s `pendingCelebrationPrizeId` logic (Requirement 1-9's Property 5) is not touched at all — this refinement only changes what renders *inside* the already-correctly-triggered `<CelebrationOverlay>`.

### Addendum Correctness Properties

Continuing the numbering from Properties 1-9 above. `getAwardedCellTermIds` is a pure function over a small, enumerable input space (4 Fixed_Pattern_Prizes × arbitrary `Winner[]` × playerId/gameId combinations × ticket shapes), making it directly property-testable with `fast-check`, consistent with Properties 1-9's existing testing approach.

### Property 10: A termId is awarded if and only if it belongs to a Fixed_Pattern_Prize's fixed cell set for which this exact player+game has a Winner

*For any* `Ticket`, `Winner[]`, `playerId`, and `gameId`, a `termId` is a member of `getAwardedCellTermIds(ticket, winners, playerId, gameId)` if and only if there exists a `prizeId` in `{FIREWALL_LINE, SECURITY_LINE, DATA_DEFENDER_LINE, CYBER_FULL_HOUSE}` such that (a) some `Winner` in `winners` has that exact `prizeId`, `gameId`, and `playerId`, and (b) `termId` belongs to that `prizeId`'s fixed cell set on `ticket` (the row at `LINE_PRIZE_ROWS[prizeId]`, or all rows for `CYBER_FULL_HOUSE`).

**Validates: Requirements 12.1, 12.2, 12.4**

### Property 11: CYBER_FIVE never contributes termIds

*For any* `Ticket`, `Winner[]` (including winners whose `prizeId` is `CYBER_FIVE`), `playerId`, and `gameId`, `getAwardedCellTermIds` never includes a termId solely on account of a `CYBER_FIVE` `Winner` record — the result is identical whether or not any `CYBER_FIVE` winners are present in `winners`.

**Validates: Requirements 12.3**

### Property 12: A Winner for a different player or a different game never contributes termIds

*For any* `Ticket`, `playerId`, `gameId`, and `Winner` whose `playerId` differs from the given `playerId` or whose `gameId` differs from the given `gameId` (including the `CLOSED_BY_OTHER_WINNER` case), adding that `Winner` to the `winners` list passed to `getAwardedCellTermIds(ticket, winners, playerId, gameId)` never changes the returned set.

**Validates: Requirements 12.4, 12.5**

### Property 13: Overlapping awarded cell sets de-duplicate via Set semantics

*For any* `Ticket` and `Winner[]` containing winners for two or more distinct Fixed_Pattern_Prizes for the same `playerId`/`gameId` whose fixed cell sets share at least one termId (e.g. any line prize together with `CYBER_FULL_HOUSE`), the shared termId appears exactly once in the returned `Set`, and the returned set equals the union of each awarded prize's individual fixed cell set.

**Validates: Requirements 12.7**

### Property 14: The awarded CSS hook is present if and only if `isAwarded` is true, additively alongside the existing marked hook

*For any* `TicketCellData` and boolean `isAwarded`, `TicketCell`'s rendered root `className` includes `ticket-cell--awarded` if and only if `isAwarded` is `true`, independently of `cell.state`, and whenever `cell.state === 'MARKED'` the className continues to include `ticket-cell--marked` and the checkmark icon continues to render regardless of `isAwarded`'s value (i.e. `isAwarded` never suppresses the existing `MARKED` rendering).

**Validates: Requirements 12.8**

## Error Handling (Addendum)

No new error states are introduced by Requirements 10-12:

- **`getAwardedCellTermIds` with no winners / no current player**: `PlayerGame.tsx`'s wiring guards with `currentPlayer?.id ?? ''` and an empty-set fallback when `currentTicket` is not yet available (mirroring the existing `renderedTicket` guard pattern), so the function is never called with `undefined` and always returns at least an empty `Set` — no cell is ever greyed by default.
- **A prize's `Winner` record referencing a `ticketId`/cell shape that doesn't match the current ticket** (e.g. stale data mid-reconnect): `getAwardedCellTermIds` only ever reads `ticket.rows`/`LINE_PRIZE_ROWS` to compute the candidate termId set — it does not trust or read anything ticket-identifying off the `Winner` record itself, so a transient mismatch cannot produce an incorrect termId; it can at most momentarily omit greying until `state.winners`/`currentTicket` are both in sync, which resolves itself on the next render once reconnect completes (Req 12.10).
- **CSS cascade ordering regression** (a future change reordering `.ticket-cell--marked` after `.ticket-cell--awarded` in `Ticket.css`): called out here as a documented risk rather than a runtime error — the Testing Strategy addendum below adds a rendered-style assertion for this specific pairing to catch such a regression in CI rather than relying on visual review alone.

## Testing Strategy (Addendum)

These are additions to the same existing test suites, not new test files, except where noted:

- **`prizeEngine.test.ts`**: add property-based tests for Properties 10-13 above (new `getAwardedCellTermIds` function), using `fast-check` at the existing minimum-100-iterations configuration and the same tagging convention (`// Feature: player-ux-improvements, Property N: <property text>`). Generators needed: arbitrary small tickets (3-row shape, consistent with the existing `Ticket` type), arbitrary `Winner[]` with controllable `prizeId`/`playerId`/`gameId` fields, arbitrary `playerId`/`gameId` strings.
- **`TicketCell.test.tsx`**: add a property-based test for Property 14 (new `isAwarded` prop) at the existing test file's conventions. Add one focused unit test asserting that when both `ticket-cell--marked` and `ticket-cell--awarded` are present, the computed/rendered background color resolves to `--state-awarded-bg` (not `--state-marked-bg`) — this is the CSS-cascade-ordering regression guard called out in Error Handling above, and is a concrete DOM-style assertion rather than a visual/manual check.
- **`CelebrationOverlay.test.tsx`**: no new test file. Requirement 11's acceptance criteria 11.2-11.5 (no new dependency, unchanged trigger condition, unchanged auto-dismiss/cleanup timing, unchanged reduced-motion branch) are regression checks — the existing tests for trigger/dismiss/cleanup/reduced-motion behavior continue to pass unchanged after `CONFETTI_COUNT` and the CSS constants are tuned, since none of those tests assert a specific piece count. One new, narrow assertion is added: rendering with `reducedMotion={false}` produces exactly `56` `.celebration-overlay__piece` elements (replacing/updating the prior `24`-count assertion if one exists), confirming Req 11.1's intensity increase landed.
- **`PlayerGame.test.tsx`**: add tests for the new `awardedTermIds` wiring — (1) a focused unit test that a `MARKED` cell belonging to a `CONFIRMED` prize's fixed cell set renders with `ticket-cell--awarded`, (2) a focused unit test for the multi-prize-overlap scenario (Property 13 exercised at the component level): a player with Winner records for both a line prize and `CYBER_FULL_HOUSE` renders every ticket cell with `ticket-cell--awarded`, not just the full-house-exclusive ones, and (3) a focused unit test confirming a `CLOSED_BY_OTHER_WINNER` prize's cells do NOT render `ticket-cell--awarded` for the current player (Req 12.5). These are fixed-scenario unit tests, not property tests, since they verify specific wiring/integration between `PlayerGame.tsx` and the new pure function rather than universal properties already covered by Properties 10-13.
- **Requirement 10 regression**: no new test file or assertion is strictly required — the diagonal strike's existing presence/absence tests (Property 8, already covering "rendered if and only if `MARKED`") are unaffected by a `background` color value change, since they assert the pseudo-element's presence via the `ticket-cell--marked` class, not its computed color. No prior test is known to assert the specific green color, so no existing assertion needs updating; if one is found during implementation to hardcode the old `--color-accent-strong` expectation, it is updated to `--color-ink` as part of this change.
- **Not covered by automated tests — explicitly manual/visual review** (consistent with the parent design's existing manual-review carve-out): the actual visual "firecracker" feel of the tuned celebration effect (Req 11.1), and final visual confirmation that the grey `ticket-cell--awarded` background doesn't clash with the dark strike or reduce perceived legibility beyond the calculated contrast ratio above (Req 12.9) at real device widths.
