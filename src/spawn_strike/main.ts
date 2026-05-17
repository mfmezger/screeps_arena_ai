import {
  ATTACK,
  BOTTOM,
  BOTTOM_LEFT,
  BOTTOM_RIGHT,
  CARRY,
  HEAL,
  LEFT,
  MOVE,
  RANGED_ATTACK,
  RESOURCE_ENERGY,
  RIGHT,
  TERRAIN_WALL,
  TOP,
  TOP_LEFT,
  TOP_RIGHT,
  TOUGH,
  WORK,
} from 'game/constants'
import {
  ConstructionSite,
  Creep,
  Flag,
  Resource,
  Source,
  StructureExtension,
  StructureSpawn,
  StructureTower,
  StructureWall,
  type BodyPartType,
  type Position,
} from 'game/prototypes'
import { createConstructionSite, findPath, getObjects, getObjectsByPrototype, getRange, getTerrainAt, getTicks, type Direction } from 'game/utils'

const TELEMETRY_ENABLED = true
const TELEMETRY_INTERVAL = 10
const DEBUG_TELEMETRY_INTERVAL = 25
const DEFENSE_RANGE = 30
const RANGED_KEEPAWAY_RANGE = 2
const EXTENSION_TARGET = 8
const MAX_WORKERS = 0
const MIN_WORKERS = 0
const ATTACK_GROUP_MIN = 8
const FLAG_RUNNER_COUNT = 3
const HEALER_FIGHTER_RATIO = 4
const SQUAD_SIZE = 4
const SQUAD_RALLY_UNTIL = 60
const SQUAD_FOLLOW_RANGE = 3
const SQUAD_CATCHUP_RANGE = 6
const SQUAD_RALLY_RANGE = 1
const SEASON_3_EXTENSION_SPAWN_RANGE = 20

const PART_COST: Record<BodyPartType, number> = {
  [ATTACK]: 80,
  [CARRY]: 50,
  [HEAL]: 250,
  [MOVE]: 50,
  [RANGED_ATTACK]: 150,
  [TOUGH]: 10,
  [WORK]: 100,
}

const flagRunnerIds = new Set<string | number>()

const SPAWN_DIRECTIONS: Array<{ direction: Direction; dx: number; dy: number }> = [
  { direction: TOP, dx: 0, dy: -1 },
  { direction: TOP_RIGHT, dx: 1, dy: -1 },
  { direction: RIGHT, dx: 1, dy: 0 },
  { direction: BOTTOM_RIGHT, dx: 1, dy: 1 },
  { direction: BOTTOM, dx: 0, dy: 1 },
  { direction: BOTTOM_LEFT, dx: -1, dy: 1 },
  { direction: LEFT, dx: -1, dy: 0 },
  { direction: TOP_LEFT, dx: -1, dy: -1 },
]

interface ArenaState {
  mySpawn?: StructureSpawn
  enemySpawn?: StructureSpawn
  myCreeps: Creep[]
  enemyCreeps: Creep[]
  sources: Source[]
  droppedEnergy: Resource[]
  flags: Flag[]
  walls: StructureWall[]
  myExtensions: StructureExtension[]
  myConstructionSites: ConstructionSite[]
}

export function loop(): void {
  const state = readArenaState()

  rememberFlagRunners(state)
  runTowers(state)
  setSpawnDirections(state)
  planExtensions(state)
  spawnCreeps(state)

  for (const creep of state.myCreeps) {
    runCreep(creep, state)
  }

  logTelemetry(state)
}

function readArenaState(): ArenaState {
  const creeps = getObjectsByPrototype(Creep).filter((creep) => creep.exists && !creep.spawning)
  const spawns = getObjectsByPrototype(StructureSpawn).filter((spawn) => spawn.exists)

  return {
    mySpawn: spawns.find((spawn) => spawn.my === true),
    enemySpawn: spawns.find((spawn) => spawn.my === false),
    myCreeps: creeps.filter((creep) => creep.my),
    enemyCreeps: creeps.filter((creep) => !creep.my),
    sources: getObjectsByPrototype(Source).filter((source) => source.exists),
    droppedEnergy: getObjectsByPrototype(Resource).filter((resource) => resource.exists && resource.resourceType === RESOURCE_ENERGY),
    flags: getObjectsByPrototype(Flag).filter((flag) => flag.exists),
    walls: getObjectsByPrototype(StructureWall).filter((wall) => wall.exists),
    myExtensions: getObjectsByPrototype(StructureExtension).filter((extension) => extension.exists && extension.my === true),
    myConstructionSites: getObjectsByPrototype(ConstructionSite).filter((site) => site.exists && site.my === true),
  }
}

function runTowers(state: ArenaState): void {
  const towers = getObjectsByPrototype(StructureTower).filter((tower) => tower.exists && tower.my && tower.cooldown === 0)

  for (const tower of towers) {
    const enemy = nearest(tower, state.enemyCreeps.filter((creep) => getRange(tower, creep) <= 20))
    if (enemy) {
      tower.attack(enemy)
      continue
    }

    const wounded = lowestHits(state.myCreeps.filter((creep) => creep.hits < creep.hitsMax && getRange(tower, creep) <= 20))
    if (wounded) {
      tower.heal(wounded)
    }
  }
}

function planExtensions(state: ArenaState): void {
  const spawn = state.mySpawn
  if (!spawn || state.myExtensions.length + state.myConstructionSites.length >= EXTENSION_TARGET) {
    return
  }

  const occupied = getObjects().filter((object) => object.exists)
  for (const offset of extensionOffsets()) {
    const pos = { x: spawn.x + offset.x, y: spawn.y + offset.y }
    if (getTerrainAt(pos) === TERRAIN_WALL || occupied.some((object) => object.x === pos.x && object.y === pos.y)) {
      continue
    }

    createConstructionSite(pos, StructureExtension)
    return
  }
}

function setSpawnDirections(state: ArenaState): void {
  if (!state.mySpawn || !state.enemySpawn) {
    return
  }

  state.mySpawn.setDirections(directionsToward(state.mySpawn, state.enemySpawn))
}

function spawnCreeps(state: ArenaState): void {
  const spawn = state.mySpawn
  if (!spawn || spawn.spawning) {
    return
  }

  const workers = state.myCreeps.filter(isWorker)
  const fighters = state.myCreeps.filter(isFighter)
  const mainFighters = fighters.filter((creep) => !isFlagRunner(creep))
  const meleeFighters = mainFighters.filter(isMeleeFighter)
  const healers = state.myCreeps.filter((creep) => hasLivePart(creep, HEAL))
  const enemiesNearSpawn = spawn ? state.enemyCreeps.filter((enemy) => getRange(spawn, enemy) <= DEFENSE_RANGE) : []
  const energy = availableSpawnEnergy(spawn, state.myExtensions)
  const fighterBody =
    fighters.length < FLAG_RUNNER_COUNT
      ? lightRangedBody(energy)
      : meleeFighters.length * SQUAD_SIZE < mainFighters.length + 1
        ? meleeBody(energy)
        : rangedBody(energy)

  if (workers.length < MIN_WORKERS) {
    spawnBody(spawn, workerBody(energy))
    return
  }

  if (enemiesNearSpawn.length > 0) {
    spawnBody(spawn, fighterBody)
    return
  }

  if (fighters.length < ATTACK_GROUP_MIN) {
    if (fighters.length >= SQUAD_SIZE && healers.length * HEALER_FIGHTER_RATIO < fighters.length) {
      spawnBody(spawn, healerBody(energy))
      return
    }

    spawnBody(spawn, fighterBody)
    return
  }

  if (workers.length < MAX_WORKERS) {
    spawnBody(spawn, workerBody(energy))
    return
  }

  if (healers.length * HEALER_FIGHTER_RATIO < fighters.length) {
    spawnBody(spawn, healerBody(energy))
    return
  }

  spawnBody(spawn, fighterBody)
}

function spawnBody(spawn: StructureSpawn, body: BodyPartType[]): void {
  if (body.length > 0) {
    spawn.spawnCreep(body)
  }
}

function runCreep(creep: Creep, state: ArenaState): void {
  const didHeal = runHealing(creep, state)
  if (!didHeal) {
    runAttacks(creep, state)
  }

  if (isWorker(creep) && !enemyNear(creep, state.enemyCreeps, 4)) {
    runWorker(creep, state)
    return
  }

  runCombatMovement(creep, state)
}

function runWorker(creep: Creep, state: ArenaState): void {
  const carriedEnergy = creep.store[RESOURCE_ENERGY] ?? 0
  const freeCapacity = creep.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0

  if (carriedEnergy === 0) {
    const dropped = nearest(creep, state.droppedEnergy.filter((resource) => resource.amount > 25))
    if (dropped && getRange(creep, dropped) <= 4) {
      if (creep.pickup(dropped) !== 0) {
        creep.moveTo(dropped)
      }
      return
    }

    const source = nearest(creep, state.sources.filter((candidate) => candidate.energy > 0))
    if (source) {
      if (creep.harvest(source) !== 0) {
        creep.moveTo(source)
      }
    }
    return
  }

  const energyTarget = chooseEnergyTarget(creep, state)
  if (energyTarget) {
    if (creep.transfer(energyTarget, RESOURCE_ENERGY) !== 0) {
      creep.moveTo(energyTarget)
    }
    return
  }

  const buildTarget = nearest(creep, state.myConstructionSites)
  if (buildTarget) {
    if (creep.build(buildTarget) !== 0) {
      creep.moveTo(buildTarget)
    }
    return
  }

  if (freeCapacity > 0) {
    const source = nearest(creep, state.sources.filter((candidate) => candidate.energy > 0))
    if (source) {
      if (creep.harvest(source) !== 0) {
        creep.moveTo(source)
      }
    }
  }
}

function chooseEnergyTarget(creep: Creep, state: ArenaState): StructureSpawn | StructureExtension | undefined {
  const targets: Array<StructureSpawn | StructureExtension> = []

  if (state.mySpawn && (state.mySpawn.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0) {
    targets.push(state.mySpawn)
  }

  for (const extension of state.myExtensions) {
    if ((extension.store.getFreeCapacity(RESOURCE_ENERGY) ?? 0) > 0) {
      targets.push(extension)
    }
  }

  return nearest(creep, targets)
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
  const closeEnemies = state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= 3)

  if (hasLivePart(creep, RANGED_ATTACK)) {
    const adjacentEnemies = closeEnemies.filter((enemy) => getRange(creep, enemy) <= 1)
    if (adjacentEnemies.length >= 2) {
      creep.rangedMassAttack()
      return
    }

    const target = combatTarget(closeEnemies)
    if (target) {
      creep.rangedAttack(target)
      return
    }

    if (state.enemySpawn && getRange(creep, state.enemySpawn) <= 3) {
      creep.rangedAttack(state.enemySpawn)
      return
    }

    const wall = lowestHits(state.walls.filter((candidate) => getRange(creep, candidate) <= 3))
    if (wall) {
      creep.rangedAttack(wall)
      return
    }
  }

  if (hasLivePart(creep, ATTACK)) {
    const target = combatTarget(state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= 1))
    if (target) {
      creep.attack(target)
      return
    }

    if (state.enemySpawn && getRange(creep, state.enemySpawn) <= 1) {
      creep.attack(state.enemySpawn)
      return
    }

    const wall = lowestHits(state.walls.filter((candidate) => getRange(creep, candidate) <= 1))
    if (wall) {
      creep.attack(wall)
    }
  }
}

function runCombatMovement(creep: Creep, state: ArenaState): void {
  if ((hasLivePart(creep, RANGED_ATTACK) || hasLivePart(creep, HEAL)) && enemyNear(creep, state.enemyCreeps, RANGED_KEEPAWAY_RANGE)) {
    const threat = nearest(creep, state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= RANGED_KEEPAWAY_RANGE))
    if (threat) {
      moveAway(creep, threat)
      return
    }
  }

  const defenseTarget = chooseDefenseTarget(state)
  if (defenseTarget) {
    creep.moveTo(defenseTarget)
    return
  }

  if (runFlagRunner(creep, state)) {
    return
  }

  if (hasLivePart(creep, HEAL) && !hasLivePart(creep, ATTACK) && !hasLivePart(creep, RANGED_ATTACK)) {
    const wounded = lowestHits(state.myCreeps.filter((ally) => ally.hits < ally.hitsMax))
    if (wounded) {
      creep.moveTo(wounded)
      return
    }

    const fighter = nearest(creep, state.myCreeps.filter((ally) => ally.id !== creep.id && isFighter(ally)))
    if (fighter) {
      creep.moveTo(fighter)
    }
    return
  }

  if (runSquadMovement(creep, state)) {
    return
  }

  const nearbyEnemy = combatTarget(state.enemyCreeps.filter((enemy) => getRange(creep, enemy) <= 6))
  if (nearbyEnemy) {
    creep.moveTo(nearbyEnemy)
    return
  }

  if (state.enemySpawn) {
    creep.moveTo(state.enemySpawn)
    return
  }

  const enemy = combatTarget(state.enemyCreeps)
  if (enemy) {
    creep.moveTo(enemy)
  }
}

function runFlagRunner(creep: Creep, state: ArenaState): boolean {
  if (!isFlagRunner(creep)) {
    return false
  }

  const target = flagTarget(creep, state) ?? nearest(creep, state.flags.filter((flag) => flag.my === true))
  if (!target) {
    return false
  }

  creep.moveTo(target)
  return true
}

function rememberFlagRunners(state: ArenaState): void {
  const livingIds = new Set(state.myCreeps.map((creep) => creep.id))
  for (const id of [...flagRunnerIds]) {
    if (!livingIds.has(id)) {
      flagRunnerIds.delete(id)
    }
  }

  if (!flagTarget(state.mySpawn ?? state.myCreeps[0] ?? { x: 0, y: 0 }, state)) {
    return
  }

  for (const fighter of [...state.myCreeps.filter(isFighter)].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (flagRunnerIds.size >= FLAG_RUNNER_COUNT) {
      return
    }
    flagRunnerIds.add(fighter.id)
  }
}

function isFlagRunner(creep: Creep): boolean {
  return flagRunnerIds.has(creep.id)
}

function runSquadMovement(creep: Creep, state: ArenaState): boolean {
  if (!isFighter(creep) || !state.mySpawn || !state.enemySpawn) {
    return false
  }

  const squad = fighterSquad(creep, state)
  const rallyPoint = squadRallyPoint(state.mySpawn, state.enemySpawn)

  if (squad.length < SQUAD_SIZE && getTicks() < SQUAD_RALLY_UNTIL) {
    if (getRange(creep, rallyPoint) > SQUAD_RALLY_RANGE) {
      creep.moveTo(rallyPoint)
    }
    return true
  }

  const leader = squad[0]
  if (!leader) {
    return false
  }

  const isLeader = creep.id === leader.id
  const lagging = squad.some((ally) => ally.id !== leader.id && getRange(ally, leader) > SQUAD_CATCHUP_RANGE)

  if (isLeader && lagging) {
    return true
  }

  if (!isLeader && getRange(creep, leader) > SQUAD_FOLLOW_RANGE) {
    creep.moveTo(leader)
    return true
  }

  const target = chooseSquadTarget(leader, state)
  if (target) {
    creep.moveTo(target)
    return true
  }

  return false
}

function fighterSquad(creep: Creep, state: ArenaState): Creep[] {
  const fighters = [...state.myCreeps.filter((fighter) => isFighter(fighter) && !isFlagRunner(fighter))].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const index = fighters.findIndex((fighter) => fighter.id === creep.id)
  if (index < 0) {
    return []
  }

  const start = Math.floor(index / SQUAD_SIZE) * SQUAD_SIZE
  return fighters.slice(start, start + SQUAD_SIZE)
}

function chooseSquadTarget(leader: Position, state: ArenaState): Position | undefined {
  const wall = blockingWallTarget(leader, state)
  if (wall) {
    return wall
  }

  if (state.mySpawn) {
    const baseThreat = combatTarget(state.enemyCreeps.filter((enemy) => getRange(state.mySpawn!, enemy) <= DEFENSE_RANGE))
    if (baseThreat) {
      return baseThreat
    }
  }

  const dangerousEnemy = combatTarget(state.enemyCreeps.filter((enemy) => getRange(leader, enemy) <= 4 || isDangerousEnemy(enemy)))
  return dangerousEnemy ?? state.enemySpawn ?? combatTarget(state.enemyCreeps)
}

function blockingWallTarget(origin: Position, state: ArenaState): StructureWall | undefined {
  if (!state.enemySpawn || state.walls.length === 0 || getRange(origin, state.enemySpawn) <= 8) {
    return undefined
  }

  const path = findPath(origin, state.enemySpawn, { maxOps: 2000 })
  if (path.length > 0) {
    return undefined
  }

  return bestWallOnRoute(origin, state.enemySpawn, state.walls)
}

function bestWallOnRoute(origin: Position, target: Position, walls: StructureWall[]): StructureWall | undefined {
  let best: StructureWall | undefined
  let bestScore = Infinity

  for (const wall of walls) {
    const score = getRange(origin, wall) * 2 + getRange(wall, target) + lineDistanceScore(wall, origin, target) * 3 + (wall.hits ?? 0) / 1000
    if (score < bestScore) {
      best = wall
      bestScore = score
    }
  }

  return best
}

function lineDistanceScore(point: Position, start: Position, end: Position): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) {
    return getRange(point, start)
  }

  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared))
  const closest = { x: start.x + dx * t, y: start.y + dy * t }
  return Math.max(Math.abs(point.x - closest.x), Math.abs(point.y - closest.y))
}

function flagTarget(origin: Position, state: ArenaState): Flag | undefined {
  return nearest(origin, state.flags.filter((candidate) => candidate.my !== true))
}

function squadRallyPoint(spawn: Position, enemySpawn: Position): Position {
  const dx = Math.sign(enemySpawn.x - spawn.x)
  const dy = Math.sign(enemySpawn.y - spawn.y)
  return { x: spawn.x + dx * 3, y: spawn.y + dy * 3 }
}

function chooseDefenseTarget(state: ArenaState): Creep | undefined {
  const spawn = state.mySpawn
  if (!spawn) {
    return undefined
  }

  return combatTarget(state.enemyCreeps.filter((enemy) => getRange(spawn, enemy) <= DEFENSE_RANGE))
}

function availableSpawnEnergy(spawn: StructureSpawn, extensions: StructureExtension[]): number {
  let total = spawn.store[RESOURCE_ENERGY] ?? 0
  for (const extension of extensions) {
    if (getRange(spawn, extension) <= SEASON_3_EXTENSION_SPAWN_RANGE) {
      total += extension.store[RESOURCE_ENERGY] ?? 0
    }
  }
  return total
}

function workerBody(energy: number): BodyPartType[] {
  return bodyCost([WORK, CARRY, MOVE]) <= energy ? [WORK, CARRY, MOVE] : []
}

function lightRangedBody(energy: number): BodyPartType[] {
  return bodyCost([MOVE, RANGED_ATTACK, MOVE]) <= energy ? [MOVE, RANGED_ATTACK, MOVE] : []
}

function meleeBody(energy: number): BodyPartType[] {
  const body: BodyPartType[] = [MOVE, MOVE, MOVE, MOVE, MOVE, ATTACK, ATTACK, ATTACK]
  return bodyCost(body) <= energy ? body : [TOUGH, MOVE, ATTACK, MOVE]
}

function rangedBody(energy: number): BodyPartType[] {
  const body: BodyPartType[] = [TOUGH, MOVE, MOVE, MOVE, MOVE, MOVE, RANGED_ATTACK, RANGED_ATTACK, RANGED_ATTACK, HEAL]
  return bodyCost(body) <= energy ? body : lightRangedBody(energy)
}

function healerBody(energy: number): BodyPartType[] {
  const body: BodyPartType[] = [MOVE, HEAL, MOVE, HEAL, MOVE]
  if (bodyCost(body) <= energy) {
    return body
  }

  const fallback: BodyPartType[] = [MOVE, HEAL, MOVE]
  return bodyCost(fallback) <= energy ? fallback : []
}

function bodyCost(body: BodyPartType[]): number {
  return body.reduce((sum, part) => sum + PART_COST[part], 0)
}

function isWorker(creep: Creep): boolean {
  return hasLivePart(creep, WORK) && hasLivePart(creep, CARRY)
}

function isFighter(creep: Creep): boolean {
  return hasLivePart(creep, ATTACK) || hasLivePart(creep, RANGED_ATTACK)
}

function isMeleeFighter(creep: Creep): boolean {
  return hasLivePart(creep, ATTACK)
}

function hasLivePart(creep: Creep, type: BodyPartType): boolean {
  return creep.body.some((part) => part.type === type && part.hits > 0)
}

function enemyNear(origin: Position, enemies: Creep[], range: number): boolean {
  return enemies.some((enemy) => getRange(origin, enemy) <= range)
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
  if (isDangerousEnemy(creep)) {
    return 6
  }
  if (hasLivePart(creep, HEAL)) {
    return 5
  }
  if (hasLivePart(creep, RANGED_ATTACK)) {
    return 4
  }
  if (hasLivePart(creep, ATTACK)) {
    return 2
  }
  if (hasLivePart(creep, WORK)) {
    return 1
  }
  return 0
}

function isDangerousEnemy(creep: Creep): boolean {
  return creep.hitsMax >= 600 || livePartCount(creep, ATTACK) >= 3 || livePartCount(creep, RANGED_ATTACK) >= 3
}

function livePartCount(creep: Creep, type: BodyPartType): number {
  return creep.body.filter((part) => part.type === type && part.hits > 0).length
}

function lowestHits<T extends { hits?: number; hitsMax?: number }>(objects: T[]): T | undefined {
  let best: T | undefined
  let bestRatio = Infinity

  for (const object of objects) {
    const ratio = (object.hits ?? 0) / (object.hitsMax ?? 1)
    if (ratio < bestRatio) {
      best = object
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

function moveAway(creep: Creep, threat: Position): void {
  const dx = Math.sign(creep.x - threat.x)
  const dy = Math.sign(creep.y - threat.y)
  const target = { x: creep.x + dx * 4, y: creep.y + dy * 4 }
  creep.moveTo(target)
}

function directionsToward(origin: Position, target: Position): Direction[] {
  return [...SPAWN_DIRECTIONS]
    .sort((a, b) => {
      const rangeA = getRange({ x: origin.x + a.dx, y: origin.y + a.dy }, target)
      const rangeB = getRange({ x: origin.x + b.dx, y: origin.y + b.dy }, target)
      return rangeA - rangeB
    })
    .map((entry) => entry.direction)
}

function extensionOffsets(): Position[] {
  return [
    { x: -2, y: -2 },
    { x: -1, y: -2 },
    { x: 0, y: -2 },
    { x: 1, y: -2 },
    { x: 2, y: -2 },
    { x: -2, y: -1 },
    { x: 2, y: -1 },
    { x: -2, y: 0 },
    { x: 2, y: 0 },
    { x: -2, y: 1 },
    { x: 2, y: 1 },
    { x: -2, y: 2 },
    { x: -1, y: 2 },
    { x: 0, y: 2 },
    { x: 1, y: 2 },
    { x: 2, y: 2 },
  ]
}

function logTelemetry(state: ArenaState): void {
  if (!TELEMETRY_ENABLED || getTicks() % TELEMETRY_INTERVAL !== 0) {
    return
  }

  const base = {
    t: getTicks(),
    s: state.mySpawn ? pointString(state.mySpawn) : undefined,
    es: state.enemySpawn ? `${pointString(state.enemySpawn)}:${state.enemySpawn.hits ?? 0}` : undefined,
    c: `${state.myCreeps.length}/${state.enemyCreeps.length}`,
    f: state.myCreeps.filter(isFighter).length,
    h: state.myCreeps.filter((creep) => hasLivePart(creep, HEAL)).length,
    e: state.mySpawn ? availableSpawnEnergy(state.mySpawn, state.myExtensions) : 0,
    sp: state.mySpawn?.spawning ? `${state.mySpawn.spawning.remainingTime}/${state.mySpawn.spawning.needTime}/${state.mySpawn.spawning.creep.body.length}` : undefined,
  }

  if (getTicks() % DEBUG_TELEMETRY_INTERVAL !== 0) {
    console.log(JSON.stringify(base))
    return
  }

  console.log(
    JSON.stringify({
      ...base,
      flags: state.flags.map((flag) => `${pointString(flag)}:${flag.my === true ? 'm' : flag.my === false ? 'e' : 'n'}`),
      path: state.mySpawn && state.enemySpawn ? findPath(state.mySpawn, state.enemySpawn, { maxOps: 2000 }).length : undefined,
      squads: squadTelemetry(state),
      my: state.myCreeps.map(creepString),
      en: state.enemyCreeps.map(creepString),
      walls: state.walls.filter((wall) => wall.hits !== undefined && wall.hits < 10000).slice(0, 8).map((wall) => `${pointString(wall)}:${wall.hits ?? 0}`),
    })
  )
}

function squadTelemetry(state: ArenaState): string[] {
  const fighters = [...state.myCreeps.filter((creep) => isFighter(creep) && !isFlagRunner(creep))].sort((a, b) => String(a.id).localeCompare(String(b.id)))
  const result: string[] = []

  for (let i = 0; i < fighters.length; i += SQUAD_SIZE) {
    const squad = fighters.slice(i, i + SQUAD_SIZE)
    const leader = squad[0]
    if (!leader) {
      continue
    }

    const target = chooseSquadTarget(leader, state)
    result.push(`${pointString(leader)}:${squad.length}:${target ? pointString(target) : '-'}`)
  }

  return result
}

function creepString(creep: Creep): string {
  return `${creep.id}@${pointString(creep)}:${creep.hits}/${creep.hitsMax}:${bodySummary(creep)}`
}

function bodySummary(creep: Creep): string {
  const counts = new Map<string, number>()
  for (const part of creep.body) {
    if (part.hits <= 0) {
      continue
    }

    counts.set(partLabel(part.type), (counts.get(partLabel(part.type)) ?? 0) + 1)
  }

  return [...counts].map(([type, count]) => `${type}${count}`).join('')
}

function partLabel(type: BodyPartType): string {
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

function pointString(object: Position): string {
  return `${object.x},${object.y}`
}

function pointTelemetry(object: Position & { id?: string | number }): { id?: string | number; x: number; y: number } {
  return { id: object.id, x: object.x, y: object.y }
}
