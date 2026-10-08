# Requirements Document

## Introduction

This feature improves the player-facing experience of the Cyber Tambola player screen (`PlayerGame.tsx` and its child components), based on feedback from live gameplay testing. It is a **UX layer on top of existing business logic** — no ticket generation, reveal, marking-eligibility, prize-eligibility, prize-validation, claim-locking, multiplayer-sync, reconnect, or host-control logic is modified.

Concretely, this feature:

1. Automatically surfaces the prize-claim action to an eligible player, instead of requiring the player to scroll down to the existing "Claim Your Prizes" card.
2. Introduces a **Prize Claim Popup** that appears automatically when a player becomes eligible, reusing the existing claim dispatch (`SUBMIT_PRIZE_CLAIM`) and existing per-prize status derivation (`derivePlayerClaimStatus`, `claimStatusView`) — no new claim-validation logic.
3. Defines how multiple simultaneously-eligible prizes are presented, without ever overlapping modals.
4. Prevents a popup from reopening for a prize that is already claimed/won (by this player or another), by reading the existing authoritative `Winner`/`PrizeClaim` state rather than inventing new local-only "already shown" state that could desync from the server.
5. Adds a diagonal strike visual across a marked ticket cell (`TicketCell.tsx`), additive to the existing checkmark, without harming text readability.
6. Adds a short celebration animation triggered only on a confirmed successful claim, respecting `prefers-reduced-motion`.
7. Ensures all of the above work at mobile widths, consistent with the existing `.player__inner` mobile-first container (`max-width: 460px`).

### Existing architecture this feature builds on (not modified)

- **Prize progress**: `getAllPrizeProgress()` / `isPrizeEligible()` in `src/utils/prizeEngine.ts` — a prize's `PrizeProgress.current >= PrizeProgress.target` is the sole eligibility signal.
- **Player claim status**: `derivePlayerClaimStatus()` in `src/utils/winnerEngine.ts` — derives one of `NOT_ELIGIBLE | ELIGIBLE | PENDING | CONFIRMED | REJECTED | CLOSED_BY_OTHER_WINNER` per prize, from the live `PrizeProgress`, the player's own latest `PrizeClaim`, and the authoritative `Winner` record. This feature's popup visibility and dismissal rules are expressed entirely in terms of this existing status, never a new parallel status.
- **Claim submission**: `PlayerGame.tsx` currently dispatches `{ type: 'SUBMIT_PRIZE_CLAIM', playerId, ticketId, prizeId }` via the existing `dispatch` from `useGameSession()`, and reads `isSubmittingClaim(prizeId)` to know whether a submission for that specific prize is in flight. The popup's CLAIM PRIZE button MUST call this exact same dispatch path.
- **Claim result messaging**: `claimStatusView()` in `PlayerGame.tsx` already derives the exact message/label/disabled state per status (e.g. the `REJECTED` branch surfaces `ownLatestClaim.rejectionReason`). The popup reuses this existing derivation rather than duplicating rejection-message logic.
- **Marked ticket cell markup**: `TicketCell.tsx` renders `<button class="ticket-cell ticket-cell--marked">` with a `.ticket-cell__term` span holding the word text, when `cell.state === 'MARKED'`.
- **Mobile container**: `.player__inner` in `PlayerGame.css` is `max-width: 460px`, the de facto mobile-first frame for everything in scope here.
- **No existing modal/dialog component and no existing animation dependency** were found in the codebase (`src/components/common`, `package.json`). This feature introduces the first of each; both are scoped as "new, minimal, reusable" rather than feature-specific one-offs, so later features can reuse them.

### Scope: Post-Implementation Refinements

Requirements 10-12 below were added after Requirements 1-9 were implemented and merged, based on further live gameplay testing of the already-built feature. They refine three already-shipped visuals — `TicketCell.tsx`/`Ticket.css`'s Diagonal_Strike, `CelebrationOverlay.tsx`'s confetti, and (newly) a greyed appearance for ticket cells belonging to a prize pattern this player has already won — rather than introducing new business logic. Each builds strictly on the existing, unmodified data sources already named above (`Player_Claim_Status`, `Prize_Progress`, the authoritative `Winner` records, and `prizeEngine.ts`'s `LINE_PRIZE_ROWS`/row-and-ticket cell mapping). No ticket generation, called-word, delayed-marking, prize-eligibility, claim-validation, first-valid-claim-wins, multiplayer-sync, reconnect, or host-control logic is touched by Requirements 10-12, consistent with Requirement 8.

## Glossary

- **Player_Screen**: The `PlayerGame` React component (`src/pages/PlayerGame/PlayerGame.tsx`) and its rendered subtree.
- **Prize_Progress**: The existing `PrizeProgress` value (`current`, `target`, `label`, `id`) produced by `getAllPrizeProgress()`.
- **Player_Claim_Status**: The existing status value produced by `derivePlayerClaimStatus()`: one of `NOT_ELIGIBLE`, `ELIGIBLE`, `PENDING`, `CONFIRMED`, `REJECTED`, `CLOSED_BY_OTHER_WINNER`.
- **Claim_Dispatch**: The existing `dispatch({ type: 'SUBMIT_PRIZE_CLAIM', playerId, ticketId, prizeId })` call already used by the "Claim Your Prizes" card's Claim button.
- **Prize_Claim_Popup**: The new modal/bottom-sheet UI introduced by this feature, shown to the Player_Screen's current player when a prize's Player_Claim_Status is `ELIGIBLE`.
- **Popup_Queue**: The ordered set of Prize_Ids currently eligible for a Prize_Claim_Popup but not yet shown/resolved for the current player.
- **Celebration_Overlay**: The new transient visual (confetti/animation or, under reduced motion, a static success state) shown after a claim reaches `CONFIRMED`.
- **Diagonal_Strike**: The new CSS visual overlay drawn across a `MARKED` Ticket_Cell.
- **Ticket_Cell**: The existing `TicketCell` component and its rendered `.ticket-cell` element.
- **Reduced_Motion_Preference**: The user agent's `prefers-reduced-motion: reduce` media feature.
- **Fixed_Pattern_Prize**: A Prize_Id whose winning cells are a determinable, fixed set of Ticket_Cells on a given Ticket: `FIREWALL_LINE` (`ticket.rows[0]`), `SECURITY_LINE` (`ticket.rows[1]`), `DATA_DEFENDER_LINE` (`ticket.rows[2]`), and `CYBER_FULL_HOUSE` (all of `ticket.rows`). `CYBER_FIVE` is explicitly excluded — it has no fixed cell set, since any 5 marked terms anywhere on the ticket qualify.
- **Awarded_Prize_Pattern**: For the current player and a given Fixed_Pattern_Prize, the condition that a `Winner` record exists (`src/types/prize.ts`) with `winner.playerId` equal to the current player's id, `winner.prizeId` equal to that Prize_Id, and `winner.gameId` equal to the current `state.game.id`.
- **Awarded_Cell_Overlay**: The new CSS visual applied to a Ticket_Cell that belongs to a Fixed_Pattern_Prize's fixed cell set once that prize has an Awarded_Prize_Pattern for the current player.

## Requirements

### Requirement 1: Automatic Prize Claim Popup on Eligibility

**User Story:** As a player, I want the claim action to appear automatically the moment I become eligible for a prize, so that I don't have to scroll down to find and press Claim.

#### Acceptance Criteria

1. WHEN a Prize_Progress transitions so that its Player_Claim_Status becomes `ELIGIBLE` for the current player, THE Player_Screen SHALL display a Prize_Claim_Popup for that Prize_Id without requiring the player to scroll.
2. THE Prize_Claim_Popup SHALL display the prize's label (`Prize_Progress.label`) and a button labeled "CLAIM PRIZE".
3. WHEN the player activates the "CLAIM PRIZE" button, THE Prize_Claim_Popup SHALL invoke the same Claim_Dispatch already used by the existing "Claim Your Prizes" card, passing the current player's id, the current ticket's id, and the popup's Prize_Id.
4. THE Prize_Claim_Popup SHALL NOT introduce any eligibility, validation, or claim-decision logic beyond what Player_Claim_Status and Claim_Dispatch already provide.
5. THE existing "Claim Your Prizes" card in the Player_Screen SHALL remain present and functionally unchanged for any prize not currently shown in a Prize_Claim_Popup.

### Requirement 2: Popup Processing, Success, and Rejection States

**User Story:** As a player, I want clear feedback while my claim is being processed, and clear next steps whether it succeeds or is rejected, so that I always know what is happening.

#### Acceptance Criteria

1. WHILE a Claim_Dispatch issued from the Prize_Claim_Popup is in flight for the popup's Prize_Id (`isSubmittingClaim(prizeId)` is true), THE Prize_Claim_Popup SHALL disable the "CLAIM PRIZE" button and display a loading state.
2. WHILE the "CLAIM PRIZE" button is disabled per Acceptance Criterion 2.1, THE Prize_Claim_Popup SHALL prevent any further Claim_Dispatch for that Prize_Id from being issued by repeated activation of the button.
3. WHEN the popup's Prize_Id's Player_Claim_Status becomes `CONFIRMED` for the current player, THE Player_Screen SHALL close the Prize_Claim_Popup for that Prize_Id and display the Celebration_Overlay.
4. WHEN the popup's Prize_Id's Player_Claim_Status becomes `REJECTED` for the current player, THE Prize_Claim_Popup SHALL display the same rejection message already produced by `claimStatusView` for the `REJECTED` status, and SHALL NOT display the Celebration_Overlay.
5. IF the popup's Prize_Id's Player_Claim_Status becomes `CLOSED_BY_OTHER_WINNER` while the Prize_Claim_Popup for that Prize_Id is open, THEN THE Player_Screen SHALL close that Prize_Claim_Popup and SHALL NOT display the Celebration_Overlay.
6. WHEN a claim is rejected per Acceptance Criterion 2.4, THE Prize_Claim_Popup SHALL re-enable the "CLAIM PRIZE" button whenever the resulting Player_Claim_Status is `ELIGIBLE` again, consistent with the existing `REJECTED` branch of `claimStatusView` allowing resubmission.
7. THE Player_Screen SHALL allow the current player to continue tapping Ticket_Cells and viewing the current Cyber Word while a Prize_Claim_Popup is open.

### Requirement 3: Multiple Simultaneously Eligible Prizes

**User Story:** As a player who becomes eligible for more than one prize at the same time, I want to see each eligible prize's claim action without the popups overlapping or confusing me, so that I can claim every prize I'm entitled to.

#### Acceptance Criteria

1. WHILE more than one Prize_Id has Player_Claim_Status `ELIGIBLE` for the current player, THE Player_Screen SHALL present the Popup_Queue so that at most one Prize_Claim_Popup is visible at any time.
2. THE Player_Screen SHALL NOT render two Prize_Claim_Popups, or a Prize_Claim_Popup overlapping a Celebration_Overlay, at the same time.
3. WHEN a Prize_Claim_Popup for a Prize_Id is closed (per Requirement 2's `CONFIRMED`, `REJECTED` dismissal, or `CLOSED_BY_OTHER_WINNER` paths, or an explicit dismissal under Requirement 4), AND another Prize_Id in the Popup_Queue still has Player_Claim_Status `ELIGIBLE`, THE Player_Screen SHALL display the Prize_Claim_Popup for that next eligible Prize_Id.
4. THE Popup_Queue SHALL order eligible Prize_Ids using the same order as `getAllPrizeProgress()` already returns them (Cyber Five, Firewall Line, Security Line, Data Defender Line, Cyber Full House), so queue order is deterministic and consistent with the existing "Claim Your Prizes" card ordering.

### Requirement 4: Popup Repetition Prevention

**User Story:** As a player, I don't want to see the same prize's claim popup again once that prize has already been claimed, confirmed, rejected-and-not-resubmittable, or won by someone else, so that I'm not repeatedly interrupted for a prize that's no longer actionable by me.

#### Acceptance Criteria

1. WHILE a Prize_Id's Player_Claim_Status is `CONFIRMED` for the current player, THE Player_Screen SHALL NOT display a Prize_Claim_Popup for that Prize_Id.
2. WHILE a Prize_Id's Player_Claim_Status is `CLOSED_BY_OTHER_WINNER`, THE Player_Screen SHALL NOT display a Prize_Claim_Popup for that Prize_Id.
3. WHILE a Prize_Id's Player_Claim_Status is `PENDING`, THE Player_Screen SHALL NOT display a new Prize_Claim_Popup for that Prize_Id.
4. IF the current player explicitly dismisses a Prize_Claim_Popup for a Prize_Id while its Player_Claim_Status remains `ELIGIBLE`, THEN THE Player_Screen SHALL NOT automatically re-display the Prize_Claim_Popup for that same Prize_Id for the remainder of the current player session, and THE existing "Claim Your Prizes" card SHALL remain available for the player to claim that prize manually.
5. THE Player_Screen SHALL derive every popup-visibility decision in Requirements 1-4 solely from the existing Player_Claim_Status, Prize_Progress, and Winner/PrizeClaim state already produced by `derivePlayerClaimStatus`, `getAllPrizeProgress`, and the synced session state — THE Player_Screen SHALL NOT introduce client-only persisted "already shown" state that can diverge from this authoritative state across a page refresh or reconnect.

### Requirement 5: Diagonal Strike on Marked Cyber Words

**User Story:** As a player, I want a clear visual strike-through on a Cyber Word I've marked, so that I can tell at a glance which words on my ticket are already marked.

#### Acceptance Criteria

1. WHEN a Ticket_Cell's state is `MARKED`, THE Ticket_Cell SHALL render a single diagonal line overlay across the cell, in addition to its existing checkmark icon.
2. THE Diagonal_Strike SHALL be implemented using CSS (including pseudo-elements) rather than replacing the cell's `.ticket-cell__term` text content.
3. THE Diagonal_Strike SHALL NOT obscure the readability of the Cyber Word text in the Ticket_Cell, for Cyber Words of any length currently present in the term bank.
4. THE Diagonal_Strike SHALL remain visually confined within the Ticket_Cell's boundaries at the mobile container width defined by `.player__inner` (`max-width: 460px`) and at wider viewport widths.
5. WHEN a Ticket_Cell's state is not `MARKED`, THE Ticket_Cell SHALL NOT render the Diagonal_Strike.

### Requirement 6: Celebration Animation on Confirmed Claim

**User Story:** As a player, I want a short celebratory animation when my prize claim is confirmed, so that winning feels rewarding, without it getting in the way of continuing to play.

#### Acceptance Criteria

1. WHEN a Prize_Id's Player_Claim_Status for the current player transitions to `CONFIRMED`, THE Player_Screen SHALL display the Celebration_Overlay.
2. THE Player_Screen SHALL NOT display the Celebration_Overlay when the current player activates the "CLAIM PRIZE" button, nor at any time before Player_Claim_Status reaches `CONFIRMED`.
3. THE Celebration_Overlay SHALL automatically dismiss itself within a few seconds without requiring player interaction.
4. WHILE the Celebration_Overlay is displayed or after it dismisses, THE Player_Screen SHALL remain usable for marking Ticket_Cells and viewing other prize blocks.
5. WHEN the Celebration_Overlay dismisses, THE Player_Screen SHALL remove every DOM element it added for the Celebration_Overlay.
6. WHERE the Reduced_Motion_Preference is active, THE Player_Screen SHALL display a static success state in place of the animated Celebration_Overlay, conveying the same confirmed-win information.
7. THE Celebration_Overlay SHALL render correctly within the mobile container width defined by `.player__inner` (`max-width: 460px`).

### Requirement 7: Mobile-First Layout

**User Story:** As a player on a smartphone, I want the claim popup, celebration, and marked-word indication to work well on my screen without forcing me to scroll in awkward ways, so that the experience feels native to my device.

#### Acceptance Criteria

1. THE Prize_Claim_Popup SHALL be fully visible and interactive, including its "CLAIM PRIZE" button, within the mobile container width defined by `.player__inner` (`max-width: 460px`) without requiring horizontal scrolling.
2. THE Prize_Claim_Popup SHALL remain fully visible and interactive on viewport heights typical of smartphone screens without the "CLAIM PRIZE" button being pushed off-screen.
3. THE Diagonal_Strike SHALL render correctly within Ticket_Cells at the mobile container width defined by `.player__inner` (`max-width: 460px`), including for the longest Cyber Words present in the term bank.
4. THE Celebration_Overlay SHALL render correctly within the mobile container width defined by `.player__inner` (`max-width: 460px`) without introducing horizontal scrolling.

### Requirement 8: Preservation of Existing Business Logic

**User Story:** As the project maintainer, I want this feature to be a UX layer only, so that the existing, already-tested game and claim logic is never put at risk.

#### Acceptance Criteria

1. THE Player_Screen SHALL NOT modify ticket generation, ticket assignment, Cyber Word reveal logic, called-word history, or delayed marking of previously-called words.
2. THE Player_Screen SHALL NOT modify prize eligibility rules (`prizeEngine.ts`), prize-claim validation, first-valid-claim-wins logic, or Supabase claim-locking behavior (`submit_claim`).
3. THE Player_Screen SHALL NOT modify multiplayer realtime sync behavior or player reconnect logic.
4. THE Player_Screen SHALL NOT modify game creation or host-control behavior.
5. THE Prize_Claim_Popup, Popup_Queue, Celebration_Overlay, and Diagonal_Strike SHALL reuse the existing `dispatch`, `isSubmittingClaim`, `derivePlayerClaimStatus`, `getAllPrizeProgress`, and `claimStatusView` functions and values rather than re-implementing equivalent logic.
6. WHERE a later design proposes removing the existing "Claim Your Prizes" / Prize Progress history section from the Player_Screen, THE design SHALL document the justification for that removal before it is implemented.

### Requirement 9: Operational — Feature Branch

**User Story:** As the project maintainer, I want this feature's implementation isolated on its own branch, so that it can be reviewed and merged independently of other in-progress work.

#### Acceptance Criteria

1. THE implementation of this feature SHALL take place on a git branch named `feature/player-ux-improvements`, created from the branch checked out at the time implementation begins.

*(Note: this requirement is operational/process-only. No branch is created during spec authoring; branch creation happens at task-execution time.)*

### Requirement 10: Diagonal Strike Color Correction

**User Story:** As a player, I want the diagonal strike on a marked Cyber Word to appear in a dark, neutral color instead of green, so that it reads clearly as a "crossed off" mark rather than looking like a status or success indicator.

#### Acceptance Criteria

1. WHEN a Ticket_Cell's state is `MARKED`, THE Diagonal_Strike SHALL render in a dark, near-black color instead of `var(--color-accent-strong)`.
2. THE Diagonal_Strike SHALL remain a single thin line, consistent with Requirement 5's existing visual, after its color is changed.
3. THE Diagonal_Strike SHALL NOT obscure the readability of the `.ticket-cell__term` text after its color is changed, consistent with Acceptance Criterion 5.3.
4. WHEN a Ticket_Cell's state is not `MARKED`, THE Ticket_Cell SHALL NOT render the Diagonal_Strike, consistent with Acceptance Criterion 5.5.

### Requirement 11: Stronger Celebration Effect

**User Story:** As a player, I want the celebration animation on a confirmed claim to feel more like a firecracker burst, so that winning feels more exciting than the current subtle confetti.

#### Acceptance Criteria

1. WHEN a Prize_Id's Player_Claim_Status for the current player transitions to `CONFIRMED`, THE Player_Screen SHALL display the Celebration_Overlay with greater visual intensity than its previously-shipped 24-piece confetti effect, by increasing one or more of: confetti piece count, piece size, color brightness/variety, or burst/spread pattern.
2. THE Celebration_Overlay SHALL continue to use only CSS (including CSS animations and pseudo-elements) to render its increased-intensity effect, introducing no new runtime dependency, unless a genuine CSS limitation is identified that prevents a firecracker-like effect.
3. THE Player_Screen SHALL NOT change the existing trigger condition for the Celebration_Overlay: it SHALL continue to display only when a Prize_Id's Player_Claim_Status transitions to `CONFIRMED` (per Acceptance Criterion 6.1 and 6.2), and never on "CLAIM PRIZE" activation or any other status.
4. THE Celebration_Overlay SHALL automatically dismiss itself, consistent with Acceptance Criterion 6.3, SHALL remain within the mobile container width defined by `.player__inner` (`max-width: 460px`) consistent with Acceptance Criterion 6.7, and SHALL remove every DOM element it added upon dismissal consistent with Acceptance Criterion 6.5, after its intensity is increased.
5. WHERE the Reduced_Motion_Preference is active, THE Player_Screen SHALL continue to display the existing static success state in place of the increased-intensity animated Celebration_Overlay, consistent with Acceptance Criterion 6.6.

### Requirement 12: Awarded Prize Pattern Greying

**User Story:** As a player who has won a prize, I want the ticket cells that make up that prize's winning pattern to appear greyed out, so that I can see at a glance which parts of my ticket are already "locked in" as a win.

#### Acceptance Criteria

1. WHEN a Fixed_Pattern_Prize has an Awarded_Prize_Pattern for the current player, THE Player_Screen SHALL render the Awarded_Cell_Overlay on every Ticket_Cell in that prize's fixed cell set.
2. THE Player_Screen SHALL determine each Fixed_Pattern_Prize's fixed cell set using the same row mapping `prizeEngine.ts` already uses (`FIREWALL_LINE` → `ticket.rows[0]`, `SECURITY_LINE` → `ticket.rows[1]`, `DATA_DEFENDER_LINE` → `ticket.rows[2]`, `CYBER_FULL_HOUSE` → all of `ticket.rows`), introducing no new row-to-prize mapping.
3. THE Player_Screen SHALL NOT render an Awarded_Cell_Overlay for `CYBER_FIVE`, since `CYBER_FIVE` is not a Fixed_Pattern_Prize and has no fixed cell set.
4. THE Player_Screen SHALL derive each Fixed_Pattern_Prize's Awarded_Prize_Pattern solely from the existing `state.winners` records for the current `state.game.id`, matched against the current player's id, without introducing any new backend field, Supabase schema change, or client-only local flag.
5. IF a Fixed_Pattern_Prize's `Winner` record belongs to a player other than the current player (the `CLOSED_BY_OTHER_WINNER` case), THEN THE Player_Screen SHALL NOT render an Awarded_Cell_Overlay on the current player's Ticket_Cells for that prize.
6. WHILE a Fixed_Pattern_Prize's Player_Claim_Status for the current player is `ELIGIBLE`, `PENDING`, `REJECTED`, or `NOT_ELIGIBLE`, THE Player_Screen SHALL NOT render an Awarded_Cell_Overlay for that prize's cells.
7. WHEN more than one Fixed_Pattern_Prize has an Awarded_Prize_Pattern for the current player at the same time, THE Player_Screen SHALL render the Awarded_Cell_Overlay independently on each prize's own fixed cell set, including on any Ticket_Cell belonging to more than one awarded prize's fixed cell set (e.g. a row cell that is also part of an awarded `CYBER_FULL_HOUSE`).
8. THE Awarded_Cell_Overlay SHALL be rendered as an additional visual layer on a `MARKED` Ticket_Cell, preserving the existing checkmark icon and the Diagonal_Strike, and SHALL NOT remove or replace either.
9. THE Awarded_Cell_Overlay SHALL NOT reduce the readability of the `.ticket-cell__term` text below the existing contrast provided for a `MARKED`, non-awarded Ticket_Cell.
10. WHEN the Player_Screen is refreshed or the current player reconnects, THE Player_Screen SHALL continue to render the Awarded_Cell_Overlay for every Fixed_Pattern_Prize that has an Awarded_Prize_Pattern for the current player, since it is derived solely from synced `state.winners`.

## Acceptance Criteria Test Scenario Coverage

The following gameplay-testing scenarios are covered by the acceptance criteria above:

1. **Marked word** → Requirement 5 (AC 5.1-5.5)
2. **Uncalled word** → Requirement 5 (AC 5.5, cell not `MARKED` renders no strike); unaffected by this feature's other requirements per Requirement 8.
3. **Prize eligibility popup** → Requirement 1 (AC 1.1-1.5)
4. **Claim submission** → Requirement 2 (AC 2.1, 2.2)
5. **Successful claim** → Requirement 2 (AC 2.3), Requirement 6 (AC 6.1-6.7)
6. **Rejected claim** → Requirement 2 (AC 2.4, 2.6)
7. **Prize already won** → Requirement 2 (AC 2.5), Requirement 4 (AC 4.2)
8. **Multiple eligible prizes** → Requirement 3 (AC 3.1-3.4)
9. **Mobile layout** → Requirement 7 (AC 7.1-7.4)
10. **Realtime update during eligibility** → Requirement 4 (AC 4.5, status-driven not client-cached), Requirement 1 (AC 1.1, reacts to live status transitions)
11. **Reconnect** → Requirement 4 (AC 4.5, no client-only persisted "already shown" state to lose or desync on reconnect)

### Post-Implementation Refinement Scenarios (Requirements 10-12)

12. **Marked tile line color** → Requirement 10 (AC 10.1-10.3)
13. **Uncalled word** → Requirement 10 (AC 10.4, cell not `MARKED` still renders no strike, unaffected by the color change)
14. **Successful claim celebration** → Requirement 11 (AC 11.1-11.4)
15. **Rejected claim** → Requirement 11 (AC 11.3, Celebration_Overlay trigger condition is unchanged and does not fire on a rejected claim, consistent with AC 2.4/6.2)
16. **Awarded prize tile greying** → Requirement 12 (AC 12.1, 12.2, 12.4, 12.8, 12.9)
17. **Eligibility without award (no greying yet)** → Requirement 12 (AC 12.6, `ELIGIBLE`/`PENDING`/`REJECTED`/`NOT_ELIGIBLE` statuses render no Awarded_Cell_Overlay)
18. **Another player wins (no greying for this player)** → Requirement 12 (AC 12.5, `CLOSED_BY_OTHER_WINNER` case)
19. **Multiple prize wins (independent greying)** → Requirement 12 (AC 12.7, independent per-prize overlay including overlapping cells)
20. **Reconnect/refresh (greying persists)** → Requirement 12 (AC 12.10, derived from synced `state.winners`)
21. **Mobile UI** → Requirement 10 (AC 10.2-10.3, strike still thin/readable at mobile width per Requirement 7), Requirement 11 (AC 11.4, overlay stays within `.player__inner` at increased intensity), Requirement 12 (AC 12.8-12.9, overlay remains readable at mobile width)
