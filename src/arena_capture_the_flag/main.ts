import { BodyPart } from 'arena/season_2/capture_the_flag/basic'
import { ATTACK, HEAL, RANGED_ATTACK, TOUGH, MOVE, WORK, CARRY } from 'game/constants'
import { Creep, Flag, StructureTower, type BodyPartType, type Position } from 'game/prototypes'
import { getDirection, getObjectsByPrototype, getRange, getTicks } from 'game/utils'
import { searchPath } from 'game/path-finder'

const FLAG_DEFENSE_RANGE = 12
const CRITICAL_DEFENSE_RESPONSE_RANGE = 25
const HOME_GUARD_TRIGGER_RANGE = 75
const HOME_DEFENDER_COUNT = 5
const HOME_DEFENDER_HOLD_RANGE = 8
const VALUABLE_BODY_PART_DETOUR_RANGE = 14
const ATTACK_BODY_PART_DETOUR_RANGE = 10
const CHEAP_BODY_PART_DETOUR_RANGE = 4
const ENEMY_FLAG_REGROUP_RANGE = 24
const MIN_ASSAULT_GROUP_SIZE = 5
const GROUP_RADIUS = 6
const RANGED_KEEPAWAY_RANGE = 2
const TELEMETRY_ENABLED = true
const TELEMETRY_INTERVAL = 5
const TELEMETRY_PREFIX = 'CTF_TELEMETRY'

interface ArenaState {
  myCreeps: Creep[]
  enemyCreeps: Creep[]
  myFlags: Flag[]
  enemyFlags: Flag[]
  myFlag?: Flag
  enemyFlag?: Flag
  bodyParts: BodyPart[]
}

interface ObjectTelemetry {
  id: string | number
  x: number
  y: number
}

interface CreepTelemetry extends ObjectTelemetry {
  hp: number
  hpMax: number
  body: string
  dMyFlag?: number
  dEnemyFlag?: number
}

export function loop(): void {
  const state = readArenaState()

  runTowers(state)

  const defenders = chooseHomeDefenders(state)
  const guard = defenders[0]
  for (const creep of state.myCreeps) {
    runCreep(creep, state, defenders)
  }

  logTelemetry(state, guard, defenders)
}

function readArenaState(): ArenaState {
  const creeps = getObjectsByPrototype(Creep).filter((creep) => creep.exists && !creep.spawning)
  const flags = getObjectsByPrototype(Flag).filter((flag) => flag.exists)

  const myFlags = flags.filter((flag) => flag.my === true)
  const enemyFlags = flags.filter((flag) => flag.my === false)

  return {
    myCreeps: creeps.filter((creep) => creep.my),
    enemyCreeps: creeps.filter((creep) => !creep.my),
    myFlags,
    enemyFlags,
    myFlag: myFlags[0],
    enemyFlag: enemyFlags[0],
    bodyParts: getObjectsByPrototype(BodyPart).filter((part) => part.exists),
  }
}

function runTowers(state: ArenaState): void {
  const towers = getObjectsByPrototype(StructureTower).filter((tower) => tower.my && tower.cooldown === 0)

  for (const tower of towers) {
    const towerTarget = nearest(tower, state.enemyCreeps)
    if (towerTarget && getRange(tower, towerTarget) <= 20) {
      tower.attack(towerTarget)
      continue
    }

    const wounded = lowestHits(state.myCreeps.filter((creep) => creep.hits < creep.hitsMax && getRange(tower, creep) <= 20))
    if (wounded) {
      tower.heal(wounded)
    }
  }
}

function chooseHomeDefenders(state: ArenaState): Creep[] {
  const threatenedFlag = chooseThreatenedFlag(state, HOME_GUARD_TRIGGER_RANGE)
  if (!threatenedFlag) {
    return []
  }

  const reserveSize = Math.min(HOME_DEFENDER_COUNT, Math.max(1, state.myCreeps.length - MIN_ASSAULT_GROUP_SIZE))
  return [...state.myCreeps]
    .sort((a, b) => defenderScore(a, threatenedFlag) - defenderScore(b, threatenedFlag))
    .slice(0, reserveSize)
}

function defenderScore(creep: Creep, flag: Flag): number {
  let score = getRange(creep, flag)
  if (hasLivePart(creep, HEAL)) {
    score -= 8
  }
  if (hasLivePart(creep, RANGED_ATTACK) || hasLivePart(creep, ATTACK)) {
    score -= 5
  }
  if (isCarrierOnly(creep)) {
    score += 12
  }
  return score
}

function runCreep(creep: Creep, state: ArenaState, defenders: Creep[]): void {
  const didHeal = runHealing(creep, state)
  if (!didHeal) {
    runAttacks(creep, state)
  }

  const movementTarget = chooseMovementTarget(creep, state, defenders)
  if (movementTarget) {
    moveSafely(creep, movementTarget, state.enemyCreeps)
  }
}

function runHealing(creep: Creep, state: ArenaState): boolean {
  if (!hasLivePart(creep, HEAL)) {
    return false
  }

  const adjacentWounded = lowestHits(state.myCreeps.filter((ally) => ally.hits < ally.hitsMax && getRange(creep, ally) <= 1))
  if (adjacentWounded) {
    creep.heal(adjacentWounded)
    return true
  }

  const rangedWounded = lowestHits(state.myCreeps.filter((ally) => ally.hits < ally.hitsMax && getRange(creep, ally) <= 3))
  if (rangedWounded) {
    creep.rangedHeal(rangedWounded)
    return true
  }

  if (creep.hits < creep.hitsMax) {
    creep.heal(creep)
    return true
  }

  return false
}

function runAttacks(creep: Creep, state: ArenaState): void {
  const nearbyEnemies = state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= 3)

  if (hasLivePart(creep, RANGED_ATTACK)) {
    const veryCloseEnemies = nearbyEnemies.filter((enemy) => getRange(creep, enemy) <= 1)
    if (veryCloseEnemies.length >= 2) {
      creep.rangedMassAttack()
      return
    }

    const target = combatTarget(nearbyEnemies)
    if (target) {
      creep.rangedAttack(target)
      return
    }
  }

  if (hasLivePart(creep, ATTACK)) {
    const target = combatTarget(state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= 1))
    if (target) {
      creep.attack(target)
    }
  }
}

function chooseMovementTarget(creep: Creep, state: ArenaState, defenders: Creep[]): Position | undefined {
  const criticalDefenseTarget = chooseDefenseTarget(state, CRITICAL_DEFENSE_RESPONSE_RANGE)
  if (criticalDefenseTarget) {
    return criticalDefenseTarget
  }

  const threatenedFlag = chooseThreatenedFlag(state, FLAG_DEFENSE_RANGE)
  const closestThreat = threatenedFlag ? nearest(threatenedFlag, state.enemyCreeps) : undefined
  if (closestThreat) {
    return closestThreat
  }

  if (defenders.some((defender) => defender.id === creep.id)) {
    const reserveDefenseTarget = chooseDefenseTarget(state, HOME_GUARD_TRIGGER_RANGE)
    if (reserveDefenseTarget) {
      return reserveDefenseTarget
    }

    const guardFlag = chooseThreatenedFlag(state, HOME_GUARD_TRIGGER_RANGE)
    if (guardFlag && getRange(creep, guardFlag) > HOME_DEFENDER_HOLD_RANGE) {
      return guardFlag
    }
  }

  const valuablePart = chooseBodyPartDetour(creep, state)
  if (valuablePart) {
    return valuablePart
  }

  const groupCenter = combatGroupCenter(state)
  if (isCarrierOnly(creep)) {
    return chooseCarrierTarget(creep, state, groupCenter)
  }

  const objectiveFlag = chooseEnemyFlagTarget(creep, state)
  if (objectiveFlag && groupCenter && getRange(creep, objectiveFlag) <= ENEMY_FLAG_REGROUP_RANGE) {
    const nearbyCombat = combatCreeps(state).filter((ally) => getRange(creep, ally) <= GROUP_RADIUS)
    if (nearbyCombat.length < MIN_ASSAULT_GROUP_SIZE) {
      return groupCenter
    }
  }

  if (hasLivePart(creep, HEAL)) {
    const wounded = lowestHits(state.myCreeps.filter((ally) => ally.hits < ally.hitsMax))
    if (wounded && getRange(creep, wounded) > 1) {
      return wounded
    }

    const fighters = state.myCreeps.filter((ally) => ally.id !== creep.id && !hasLivePart(ally, HEAL))
    const anchor = nearest(creep, fighters)
    if (anchor && getRange(creep, anchor) > 2) {
      return anchor
    }
  }

  if (groupCenter && getRange(creep, groupCenter) > GROUP_RADIUS) {
    return groupCenter
  }

  return objectiveFlag
}

function chooseCarrierTarget(creep: Creep, state: ArenaState, groupCenter: Position | undefined): Position | undefined {
  const fighters = combatCreeps(state).filter((ally) => ally.id !== creep.id)
  const anchor = nearest(creep, fighters)

  const objectiveFlag = chooseEnemyFlagTarget(creep, state)
  if (!objectiveFlag) {
    return anchor ?? groupCenter
  }

  const nearbyCombat = fighters.filter((ally) => getRange(creep, ally) <= GROUP_RADIUS)
  if (nearbyCombat.length >= MIN_ASSAULT_GROUP_SIZE && getRange(creep, objectiveFlag) <= ENEMY_FLAG_REGROUP_RANGE) {
    return objectiveFlag
  }

  return anchor ?? groupCenter ?? objectiveFlag
}

function chooseThreatenedFlag(state: ArenaState, responseRange: number): Flag | undefined {
  let bestFlag: Flag | undefined
  let bestRange = Infinity

  for (const flag of state.myFlags) {
    const closestEnemy = nearest(flag, state.enemyCreeps)
    if (!closestEnemy) {
      continue
    }

    const range = getRange(flag, closestEnemy)
    if (range <= responseRange && range < bestRange) {
      bestFlag = flag
      bestRange = range
    }
  }

  return bestFlag
}

function chooseDefenseTarget(state: ArenaState, responseRange: number): Creep | undefined {
  let bestEnemy: Creep | undefined
  let bestRange = Infinity

  for (const flag of state.myFlags) {
    for (const enemy of state.enemyCreeps) {
      const range = getRange(flag, enemy)
      if (range <= responseRange && range < bestRange) {
        bestEnemy = enemy
        bestRange = range
      }
    }
  }

  return bestEnemy
}

function chooseEnemyFlagTarget(origin: Position, state: ArenaState): Flag | undefined {
  return nearest(origin, state.enemyFlags)
}

function chooseBodyPartDetour(creep: Creep, state: ArenaState): BodyPart | undefined {
  let bestPart: BodyPart | undefined
  let bestScore = 0

  for (const part of state.bodyParts) {
    const range = getRange(creep, part)
    if (range > bodyPartDetourRange(part.type)) {
      continue
    }

    const score = bodyPartScore(part.type) * 10 - range
    if (score > bestScore) {
      bestScore = score
      bestPart = part
    }
  }

  return bestPart
}

function moveSafely(creep: Creep, target: Position, enemies: Creep[]): void {
  if (hasLivePart(creep, RANGED_ATTACK) || hasLivePart(creep, HEAL)) {
    const closeEnemies = enemies.filter((enemy) => getRange(creep, enemy) <= RANGED_KEEPAWAY_RANGE)
    if (closeEnemies.length > 0) {
      flee(creep, closeEnemies, 3)
      return
    }
  }

  creep.moveTo(target)
}

function flee(creep: Creep, threats: Position[], range: number): void {
  const result = searchPath(
    creep,
    threats.map((threat) => ({ pos: threat, range })),
    { flee: true }
  )

  const next = result.path[0]
  if (next) {
    creep.move(getDirection(next.x - creep.x, next.y - creep.y))
  }
}

function logTelemetry(state: ArenaState, guard: Creep | undefined, defenders: Creep[]): void {
  if (!TELEMETRY_ENABLED || getTicks() % TELEMETRY_INTERVAL !== 0) {
    return
  }

  const closestEnemyToMyFlag = state.myFlag ? nearest(state.myFlag, state.enemyCreeps) : undefined
  const closestMyCreepToEnemyFlag = state.enemyFlag ? nearest(state.enemyFlag, state.myCreeps) : undefined

  console.log(
    `${TELEMETRY_PREFIX} ${JSON.stringify({
      tick: getTicks(),
      counts: {
        my: state.myCreeps.length,
        enemy: state.enemyCreeps.length,
        bodyParts: state.bodyParts.length,
      },
      flags: {
        my: state.myFlag ? pointTelemetry(state.myFlag) : undefined,
        enemy: state.enemyFlag ? pointTelemetry(state.enemyFlag) : undefined,
      },
      closest: {
        enemyToMyFlag: closestEnemyToMyFlag ? creepTelemetry(closestEnemyToMyFlag, state) : undefined,
        myToEnemyFlag: closestMyCreepToEnemyFlag ? creepTelemetry(closestMyCreepToEnemyFlag, state) : undefined,
      },
      guard: guard ? guard.id : undefined,
      defenders: defenders.map((defender) => defender.id),
      my: state.myCreeps.map((creep) => creepTelemetry(creep, state)),
      enemy: state.enemyCreeps.map((creep) => creepTelemetry(creep, state)),
      bodyParts: state.bodyParts.map((part) => ({ ...pointTelemetry(part), type: part.type, decay: part.ticksToDecay })),
    })}`
  )
}

function creepTelemetry(creep: Creep, state: ArenaState): CreepTelemetry {
  return {
    ...pointTelemetry(creep),
    hp: creep.hits,
    hpMax: creep.hitsMax,
    body: bodySummary(creep),
    dMyFlag: state.myFlag ? getRange(creep, state.myFlag) : undefined,
    dEnemyFlag: state.enemyFlag ? getRange(creep, state.enemyFlag) : undefined,
  }
}

function pointTelemetry(object: ObjectTelemetry): ObjectTelemetry {
  return { id: object.id, x: object.x, y: object.y }
}

function bodySummary(creep: Creep): string {
  const counts = new Map<string, number>()
  for (const part of creep.body) {
    if (part.hits <= 0) {
      continue
    }

    const label = bodyPartLabel(part.type)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }

  return [...counts].map(([label, count]) => `${label}${count}`).join('')
}

function bodyPartLabel(type: BodyPartType): string {
  switch (type) {
    case ATTACK:
      return 'A'
    case CARRY:
      return 'C'
    case HEAL:
      return 'H'
    case MOVE:
      return 'M'
    case RANGED_ATTACK:
      return 'R'
    case TOUGH:
      return 'T'
    case WORK:
      return 'W'
  }
}

function combatCreeps(state: ArenaState): Creep[] {
  return state.myCreeps.filter((creep) => hasLivePart(creep, ATTACK) || hasLivePart(creep, RANGED_ATTACK) || hasLivePart(creep, HEAL))
}

function combatGroupCenter(state: ArenaState): Position | undefined {
  const creeps = combatCreeps(state)
  if (creeps.length === 0) {
    return undefined
  }

  const totals = creeps.reduce(
    (sum, creep) => ({ x: sum.x + creep.x, y: sum.y + creep.y }),
    { x: 0, y: 0 }
  )

  return {
    x: Math.round(totals.x / creeps.length),
    y: Math.round(totals.y / creeps.length),
  }
}

function isCarrierOnly(creep: Creep): boolean {
  return (
    hasLivePart(creep, CARRY) &&
    !hasLivePart(creep, ATTACK) &&
    !hasLivePart(creep, RANGED_ATTACK) &&
    !hasLivePart(creep, HEAL)
  )
}

function hasLivePart(creep: Creep, type: BodyPartType): boolean {
  return creep.body.some((part) => part.type === type && part.hits > 0)
}

function combatTarget<T extends Creep>(creeps: T[]): T | undefined {
  let best: T | undefined
  let bestScore = -Infinity

  for (const creep of creeps) {
    const score = targetPriority(creep) * 1000 + (1 - creep.hits / creep.hitsMax) * 100
    if (score > bestScore) {
      best = creep
      bestScore = score
    }
  }

  return best
}

function targetPriority(creep: Creep): number {
  if (hasLivePart(creep, HEAL)) {
    return 4
  }
  if (hasLivePart(creep, RANGED_ATTACK)) {
    return 3
  }
  if (hasLivePart(creep, ATTACK)) {
    return 2
  }
  return 1
}

function lowestHits<T extends Creep>(creeps: T[]): T | undefined {
  let best: T | undefined
  let bestRatio = Infinity

  for (const creep of creeps) {
    const ratio = creep.hits / creep.hitsMax
    if (ratio < bestRatio) {
      best = creep
      bestRatio = ratio
    }
  }

  return best
}

function nearest<T extends Position>(origin: Position, positions: T[]): T | undefined {
  let best: T | undefined
  let bestRange = Infinity

  for (const position of positions) {
    const range = getRange(origin, position)
    if (range < bestRange) {
      best = position
      bestRange = range
    }
  }

  return best
}

function bodyPartDetourRange(type: BodyPartType): number {
  switch (type) {
    case HEAL:
    case RANGED_ATTACK:
      return VALUABLE_BODY_PART_DETOUR_RANGE
    case ATTACK:
      return ATTACK_BODY_PART_DETOUR_RANGE
    case MOVE:
      return CHEAP_BODY_PART_DETOUR_RANGE
    case TOUGH:
    case WORK:
    case CARRY:
      return 1
  }
}

function bodyPartScore(type: BodyPartType): number {
  switch (type) {
    case HEAL:
      return 6
    case RANGED_ATTACK:
      return 5
    case ATTACK:
      return 3
    case MOVE:
    case TOUGH:
    case WORK:
    case CARRY:
      return 1
  }
}
