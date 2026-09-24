# Cyber Tambola V2 — Cyber Word Tambola

Module 1: a polished, responsive front-end **prototype** built with React + TypeScript + Vite.
This module demonstrates the intended user experience using **mock data only** — no backend,
authentication, database, real-time sync, or claim processing.

## Screens

| Route            | Screen              | Optimised for            |
| ---------------- | ------------------- | ------------------------ |
| `/`              | Player Join         | Mobile (portrait)        |
| `/player`        | Player Game         | Mobile (portrait)        |
| `/host`          | Host Dashboard      | Laptop / desktop         |
| `/presentation`  | Projector View      | Projector (read-only)    |

A subtle prototype navigation control (bottom-right) lets you move between screens during demos.

## Running locally

Node.js 18+ is required.

```bash
npm install
npm run dev      # start the dev server (Vite prints the local URL)
```

Other useful scripts:

```bash
npm run build      # type-check and produce a production build in dist/
npm run preview    # preview the production build
npm run typecheck  # TypeScript check only
```

## Project structure

```
src/
  components/
    common/        Shared UI (Button, Card, CyberWordCard, QrPlaceholder, ...)
    player/        Player-only UI (Ticket, TicketCell, PrizeProgressList)
  pages/
    PlayerJoin/    Screen A
    PlayerGame/    Screen B
    HostDashboard/ Screen C
    PresentationView/ Screen D
  data/            Mock data (mockTerms, mockTicket, mockGame, mockClaims)
  types/           TypeScript types (game, player, cyberTerm, prize)
  styles/          Global design system (global.css)
  App.tsx          Routing + app shell
```

## Scope

Implements **Module 1 only** (static UI shell with mock data). Backend, real multiplayer,
persistence, authentication, server-side prize validation, and production infrastructure are
intentionally out of scope and deferred to later modules.
