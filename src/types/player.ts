/**
 * An employee participating in a Cyber Tambola session.
 * `displayName`, `ticketId`, and `joinedAt` are the Module 2 domain fields.
 * `name` and `ticketRef` remain for the existing player UI (aliases kept to
 * avoid a needless UI rewrite in this module).
 *
 * There is deliberately no Employee ID / Demo ID field: the Join screen no
 * longer collects one, and player identity/duplicate-join restoration is
 * resolved by an opaque, non-personal device-local join token instead (see
 * `src/state/joinService.ts`'s `readOrCreateDeviceJoinToken`) — never by
 * `displayName`, since different employees can share a name.
 */
export interface Player {
  id: string
  /** Id of the game session this player belongs to. */
  gameId: string // NEW (Req 4.1)
  /** Name shown to the player, e.g. "Divyansh". */
  displayName: string
  /** Reference to the ticket assigned to this player. */
  ticketId: string
  /** ISO timestamp of when the player joined (local/mock in Module 2). */
  joinedAt: string

  // --- UI-facing aliases retained from Module 1 ---
  /** Alias of displayName used by existing player screens. */
  name: string
  /** Human-friendly ticket reference, e.g. "Ticket #021". */
  ticketRef: string
}

/** Values captured on the Player Join screen. */
export interface JoinFormValues {
  gameCode: string
  employeeName: string
}
