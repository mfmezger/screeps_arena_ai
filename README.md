# Screeps Arena AI

TypeScript project for Screeps Arena, starting with **Season 2: Capture the Flag**.

## Setup

```bash
npm install
npm run build
```

The Capture the Flag bundle is written to:

```text
dist/arena_capture_the_flag/main.mjs
```

In the Screeps Arena client, point the Capture the Flag arena code folder at `dist/arena_capture_the_flag`.

## Scripts

- `npm run typecheck` — TypeScript check only.
- `npm run build:ctf` — build Capture the Flag without typechecking.
- `npm run build` — typecheck, then build Capture the Flag.
- `npm run watch:ctf` — rebuild Capture the Flag while editing.

## Telemetry

The Capture the Flag bot logs compact JSON snapshots every 5 ticks with the prefix `CTF_TELEMETRY`.
After a match, copy those console lines here and they can be analyzed for positioning, healing, deaths, flag pressure, and body part pickups.

## Project notes

This repo uses the Arena API, not Screeps World/MMO globals. Prefer imports from built-in Arena modules such as:

```ts
import { Creep, Flag } from 'game/prototypes'
import { getObjectsByPrototype } from 'game/utils'
import { BodyPart } from 'arena/season_2/capture_the_flag/basic'
```
