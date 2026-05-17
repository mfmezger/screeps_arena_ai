# Screeps Arena AI

TypeScript project for Screeps Arena bots.

## Setup

```bash
npm install
npm run build
```

Bundles are written to:

```text
dist/arena_capture_the_flag/main.mjs
dist/spawn_strike/main.mjs
```

In the Screeps Arena client, point each arena code folder at the matching `dist/...` directory.

## Scripts

- `npm run typecheck` — TypeScript check only.
- `npm run build:ctf` — build Capture the Flag without typechecking.
- `npm run build:spawn-strike` — build Spawn Strike without typechecking.
- `npm run build` — typecheck, then build all configured arenas.
- `npm run watch:ctf` — rebuild Capture the Flag while editing.
- `npm run watch:spawn-strike` — rebuild Spawn Strike while editing.

## Telemetry

The Capture the Flag bot logs compact JSON snapshots every 5 ticks with the prefix `CTF_TELEMETRY`.
The Spawn Strike bot logs compact JSON snapshots every 10 ticks as raw JSON, without a prefix.
After a match, copy those console lines here and they can be analyzed for positioning, healing, deaths, economy, and objective pressure.

## Project notes

This repo uses the Arena API, not Screeps World/MMO globals. Prefer imports from built-in Arena modules such as:

```ts
import { Creep, Flag } from 'game/prototypes'
import { getObjectsByPrototype } from 'game/utils'
import { BodyPart } from 'arena/season_2/capture_the_flag/basic'
```
