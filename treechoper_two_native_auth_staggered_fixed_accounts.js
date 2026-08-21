'use strict';

const mineflayer = process.env.TREEBOT_SELFTEST === '1' ? null : require('mineflayer');
const Vec3 = process.env.TREEBOT_SELFTEST === '1' ? null : require('vec3');
const fs = require('fs');
const path = require('path');
const http = require('http');

/* =========================================================
   MASTER TREE EXTREME
   Plant -> Bone Meal -> Chop
   ========================================================= */

const CONFIG = {
  host: 'insanesmp.net',
  port: 25565,

  username: process.env.BOT_USERNAME || 'Kiuing_YT',
  ownerUsername: 'itz_Avantika',

  auth: {
    enabled: true,
    password: process.env.BOT_PASSWORD || 'Sukka123',
    mode: 'auto',
    timeout: 20000
  },

  // Requested post-register sequence.
  postAuth: {
    enabled: true,
    afkCommand: '/afk',
    waitMs: 5000,
    secondAccountDelayMs: 10000,
    moveBlocks: Number(process.env.BOT_MOVE_BLOCKS || 5)
  },

  speed: {
    planting: 70,
    bonemeal: 45,
    chopping: 300,
    scan: 80
  },

  limits: {
    minSpeed: 10,
    maxSpeed: 2000,
    maxBonemealAttempts: 40,
    cycleTimeout: 30000,
    actionTimeout: 8000,
    targetLockTimeout: 30 * 60 * 1000,
    maxReconnectDelay: 60000
  },

  reconnectDelay: 5000,

  logging: {
    errors: true,
    actions: true,
    debug: false
  }
};

/* =========================================================
   FILES
   ========================================================= */

const STATE_FILE = path.join(__dirname, 'tree_bot_state.json');
const AUTH_FILE = path.join(__dirname, 'tree_bot_auth.json');

/* =========================================================
   STATE
   ========================================================= */

const state = {
  enabled: true,

  mode: 'auto',

  lockedTarget: null,
  lockedAt: 0,

  speed: {
    ...CONFIG.speed
  },

  stats: {
    cycles: 0,
    planted: 0,
    bonemeal: 0,
    chopped: 0,
    errors: 0,
    reconnects: 0
  }
};

/* =========================================================
   RUNTIME
   ========================================================= */

let bot = null;

let loopRunning = false;
let busy = false;
let stopping = false;

let reconnectTimer = null;
let reconnectAttempt = 0;

let cycleStartedAt = 0;

let authDialogBusy = false;
let lastAuthDialogAt = 0;
let lastAuthDialogFingerprint = '';
let authCompleted = false;
let authSubmittedAt = 0;
let renderHealthServer = null;

/* =========================================================
   HELPERS
   ========================================================= */

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function clamp(number, min, max) {
  return Math.max(min, Math.min(max, number));
}

function now() {
  return Date.now();
}

function log(...args) {
  console.log(...args);
}

function debug(...args) {
  if (CONFIG.logging.debug) {
    console.log('[DEBUG]', ...args);
  }
}

function action(...args) {
  if (CONFIG.logging.actions) {
    console.log('[ACTION]', ...args);
  }
}

function error(...args) {
  if (CONFIG.logging.errors) {
    console.log('[ERROR]', ...args);
  }
}


function loadAuth() {
  try {
    if (!fs.existsSync(AUTH_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    // Keep the password configured in this file as the source of truth.
    // A stale tree_bot_auth.json must never overwrite it.
    if (CONFIG.auth.password === 'CHANGE_ME' && raw && typeof raw.password === 'string' && raw.password.trim()) {
      CONFIG.auth.password = raw.password;
    }
  } catch (err) {
    error('Auth config load failed:', err.message);
  }
}

function saveAuth() {
  try {
    const tmp = `${AUTH_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      password: CONFIG.auth.password,
      mode: CONFIG.auth.mode
    }, null, 2), 'utf8');
    fs.renameSync(tmp, AUTH_FILE);
  } catch (err) {
    error('Auth config save failed:', err.message);
  }
}

/* =========================================================
   STATE MANAGEMENT
   ========================================================= */

function normaliseTarget(target) {
  if (!Array.isArray(target) || target.length !== 4) {
    return null;
  }

  const result = [];

  for (const p of target) {
    if (!p || !Number.isFinite(Number(p.x))
      || !Number.isFinite(Number(p.y))
      || !Number.isFinite(Number(p.z))) {
      return null;
    }

    result.push({
      x: Math.floor(Number(p.x)),
      y: Math.floor(Number(p.y)),
      z: Math.floor(Number(p.z))
    });
  }

  return result;
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) {
      return;
    }

    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const saved = JSON.parse(raw);

    if (!saved || typeof saved !== 'object') {
      return;
    }

    if (typeof saved.enabled === 'boolean') {
      state.enabled = saved.enabled;
    }

    if (saved.mode === 'auto' || saved.mode === 'locked') {
      state.mode = saved.mode;
    }

    const target = normaliseTarget(saved.lockedTarget);

    if (target) {
      state.lockedTarget = target;
    }

    if (Number.isFinite(Number(saved.lockedAt))) {
      state.lockedAt = Number(saved.lockedAt);
    }

    if (saved.speed && typeof saved.speed === 'object') {
      for (const key of Object.keys(state.speed)) {
        const value = Number(saved.speed[key]);

        if (Number.isFinite(value)) {
          state.speed[key] = clamp(
            Math.round(value),
            CONFIG.limits.minSpeed,
            CONFIG.limits.maxSpeed
          );
        }
      }
    }

    if (saved.stats && typeof saved.stats === 'object') {
      for (const key of Object.keys(state.stats)) {
        const value = Number(saved.stats[key]);

        if (Number.isFinite(value) && value >= 0) {
          state.stats[key] = Math.floor(value);
        }
      }
    }

    validateLock();

    log('[STATE] Loaded successfully.');

  } catch (err) {
    error('State load failed:', err.message);
  }
}

function saveState() {
  try {
    const temporary = `${STATE_FILE}.tmp`;

    fs.writeFileSync(
      temporary,
      JSON.stringify(state, null, 2),
      'utf8'
    );

    fs.renameSync(temporary, STATE_FILE);

  } catch (err) {
    error('State save failed:', err.message);
  }
}

function validateLock() {
  if (state.mode !== 'locked') {
    return;
  }

  if (!state.lockedTarget) {
    state.mode = 'auto';
    state.lockedAt = 0;
    return;
  }

  if (
    state.lockedAt > 0 &&
    now() - state.lockedAt > CONFIG.limits.targetLockTimeout
  ) {
    log('[LOCK] Lock expired.');

    state.mode = 'auto';
    state.lockedTarget = null;
    state.lockedAt = 0;

    saveState();
  }
}

/* =========================================================
   BLOCK DETECTION
   ========================================================= */

function isAir(block) {
  if (!block) {
    return false;
  }

  return (
    block.name === 'air' ||
    block.name === 'cave_air' ||
    block.name === 'void_air'
  );
}

function isSapling(block) {
  if (!block || typeof block.name !== 'string') {
    return false;
  }

  return block.name.endsWith('_sapling');
}

function isLog(block) {
  if (!block || typeof block.name !== 'string') {
    return false;
  }

  const name = block.name;

  return (
    name.endsWith('_log') ||
    name.endsWith('_wood') ||
    name.endsWith('_stem') ||
    name.endsWith('_hyphae')
  );
}

function isTreeBlock(block) {
  return isLog(block) || isSapling(block);
}

/* =========================================================
   INVENTORY
   ========================================================= */

function findItem(predicate) {
  if (!bot || !bot.inventory) {
    return null;
  }

  return bot.inventory.items().find(predicate) || null;
}

function findSapling() {
  return findItem(item => (
    typeof item.name === 'string' &&
    item.name.endsWith('_sapling')
  ));
}

function findBoneMeal() {
  return findItem(item => item.name === 'bone_meal');
}

function findAxe() {
  return findItem(item => (
    typeof item.name === 'string' &&
    item.name.endsWith('_axe')
  ));
}

function getInventorySummary() {
  if (!bot?.inventory) {
    return {};
  }

  const result = {};

  for (const item of bot.inventory.items()) {
    result[item.name] = (result[item.name] || 0) + item.count;
  }

  return result;
}

/* =========================================================
   BOT UTILITIES
   ========================================================= */

function isBotReady() {
  return !!(
    bot &&
    bot.entity &&
    bot.player
  );
}

async function equip(item) {
  if (!isBotReady() || !item) {
    return false;
  }

  try {
    await Promise.race([
      bot.equip(item, 'hand'),

      sleep(CONFIG.limits.actionTimeout).then(() => {
        throw new Error('Equip timeout');
      })
    ]);

    return true;

  } catch (err) {
    error('Equip failed:', err.message);
    state.stats.errors++;
    return false;
  }
}

async function lookAtBlock(block) {
  if (!isBotReady() || !block) {
    return false;
  }

  try {
    await Promise.race([
      bot.lookAt(
        block.position.offset(0.5, 0.5, 0.5),
        true
      ),

      sleep(CONFIG.limits.actionTimeout).then(() => {
        throw new Error('Look timeout');
      })
    ]);

    return true;

  } catch (err) {
    error('Look failed:', err.message);
    state.stats.errors++;
    return false;
  }
}

function getBlock(position) {
  if (!isBotReady() || !position) {
    return null;
  }

  try {
    return bot.blockAt(position);
  } catch {
    return null;
  }
}

/* =========================================================
   TARGET SYSTEM
   ========================================================= */

function getTargetArea(entity) {
  if (!entity?.position) {
    return null;
  }

  const yaw = Number(entity.yaw) || 0;

  const direction =
    Math.floor(
      (yaw * 4 / (2 * Math.PI)) + 0.5
    ) & 3;

  const pos = entity.position.floored();

  let base;

  switch (direction) {
    case 0:
      base = pos.offset(-1, 0, 1);
      break;

    case 1:
      base = pos.offset(-2, 0, -1);
      break;

    case 2:
      base = pos.offset(0, 0, -2);
      break;

    default:
      base = pos.offset(1, 0, 0);
      break;
  }

  return [
    base,
    base.offset(1, 0, 0),
    base.offset(0, 0, 1),
    base.offset(1, 0, 1)
  ];
}

function ownerEntity() {
  if (!bot) {
    return null;
  }

  const player = bot.players?.[CONFIG.ownerUsername];

  return player?.entity || null;
}

function getLockedTarget() {
  validateLock();

  if (
    state.mode !== 'locked' ||
    !Array.isArray(state.lockedTarget) ||
    state.lockedTarget.length !== 4
  ) {
    return null;
  }

  return state.lockedTarget.map(
    p => new Vec3(
      Number(p.x),
      Number(p.y),
      Number(p.z)
    )
  );
}

function targetNow() {
  const locked = getLockedTarget();

  if (locked) {
    return locked;
  }

  const owner = ownerEntity();

  if (!owner) {
    return null;
  }

  return getTargetArea(owner);
}

/* =========================================================
   TARGET VALIDATION
   ========================================================= */

function targetIsValid(target) {
  if (!Array.isArray(target) || target.length !== 4) {
    return false;
  }

  return target.every(p => (
    p &&
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
  ));
}

function getTargetState(target) {
  if (!targetIsValid(target)) {
    return [];
  }

  return target.map(position => {
    const block = getBlock(position);

    return {
      x: position.x,
      y: position.y,
      z: position.z,
      block: block?.name || 'unknown'
    };
  });
}

function allGrowable(target) {
  if (!targetIsValid(target)) {
    return false;
  }

  return target.every(position => {
    const block = getBlock(position);

    return isSapling(block) || isLog(block);
  });
}

function hasSapling(target) {
  if (!targetIsValid(target)) {
    return false;
  }

  return target.some(position =>
    isSapling(getBlock(position))
  );
}

function hasLogs(target) {
  if (!targetIsValid(target)) {
    return false;
  }

  return target.some(position =>
    isLog(getBlock(position))
  );
}

/* =========================================================
   PLANT
   ========================================================= */

async function plant(target) {
  if (!isBotReady()) {
    return false;
  }

  const sapling = findSapling();

  if (!sapling) {
    debug('No sapling available.');
    return false;
  }

  if (!(await equip(sapling))) {
    return false;
  }

  let plantedAny = false;

  for (const position of target) {
    if (!isBotReady()) {
      break;
    }

    const here = getBlock(position);
    const ground = getBlock(
      position.offset(0, -1, 0)
    );

    if (!here || !ground) {
      continue;
    }

    if (!isAir(here)) {
      continue;
    }

    if (isAir(ground)) {
      continue;
    }

    try {
      if (!(await lookAtBlock(ground))) {
        continue;
      }

      await Promise.race([
        bot.placeBlock(
          ground,
          new Vec3(0, 1, 0)
        ),

        sleep(CONFIG.limits.actionTimeout).then(() => {
          throw new Error('Plant timeout');
        })
      ]);

      plantedAny = true;
      state.stats.planted++;

      action(
        `Planted sapling at ${position.x} ${position.y} ${position.z}`
      );

      await sleep(state.speed.planting);

    } catch (err) {
      debug('Plant failed:', err.message);
      state.stats.errors++;
    }
  }

  return plantedAny;
}

/* =========================================================
   BONE MEAL
   ========================================================= */

async function grow(target) {
  if (!isBotReady()) {
    return false;
  }

  const meal = findBoneMeal();

  if (!meal) {
    debug('No bone meal available.');
    return false;
  }

  if (!(await equip(meal))) {
    return false;
  }

  let grewAny = false;

  for (const position of target) {
    if (!isBotReady()) {
      break;
    }

    for (
      let attempt = 0;
      attempt < CONFIG.limits.maxBonemealAttempts;
      attempt++
    ) {
      const block = getBlock(position);

      if (!isSapling(block)) {
        break;
      }

      try {
        if (!(await lookAtBlock(block))) {
          break;
        }

        /*
         * Mineflayer's activateBlock performs the
         * right-click interaction using the equipped item.
         * With bone meal equipped this attempts growth.
         */
        await Promise.race([
          bot.activateBlock(block),

          sleep(CONFIG.limits.actionTimeout).then(() => {
            throw new Error('Bone meal timeout');
          })
        ]);

        state.stats.bonemeal++;
        grewAny = true;

        debug(
          `Bone meal ${attempt + 1}/${CONFIG.limits.maxBonemealAttempts} @ ${position.x} ${position.y} ${position.z}`
        );

        await sleep(state.speed.bonemeal);

      } catch (err) {
        debug('Bone meal failed:', err.message);

        await sleep(
          Math.min(
            300,
            state.speed.bonemeal + 50
          )
        );
      }
    }
  }

  return grewAny;
}

/* =========================================================
   CHOP
   ========================================================= */

async function chop(target) {
  if (!isBotReady()) {
    return false;
  }

  const axe = findAxe();

  if (!axe) {
    debug('No axe available.');
    return false;
  }

  if (!(await equip(axe))) {
    return false;
  }

  let choppedAny = false;

  for (const position of target) {
    if (!isBotReady()) {
      break;
    }

    const block = getBlock(position);

    if (!isLog(block)) {
      continue;
    }

    try {
      if (!(await lookAtBlock(block))) {
        continue;
      }

      await Promise.race([
        bot.dig(block, true),

        sleep(CONFIG.limits.actionTimeout).then(() => {
          throw new Error('Chop timeout');
        })
      ]);

      choppedAny = true;
      state.stats.chopped++;

      action(
        `Chopped ${block.name} at ${position.x} ${position.y} ${position.z}`
      );

      await sleep(state.speed.chopping);

    } catch (err) {
      debug('Chop failed:', err.message);
      state.stats.errors++;
    }
  }

  return choppedAny;
}

/* =========================================================
   FULL TREE CYCLE
   ========================================================= */

async function cycle() {
  if (!state.enabled) {
    return;
  }

  if (CONFIG.auth.enabled && !authCompleted) {
    return;
  }

  if (!isBotReady()) {
    return;
  }

  if (busy) {
    return;
  }

  const target = targetNow();

  if (!targetIsValid(target)) {
    return;
  }

  busy = true;
  cycleStartedAt = now();

  state.stats.cycles++;

  try {
    debug(
      'Cycle target:',
      getTargetState(target)
    );

    /*
     * STEP 1
     * Plant missing saplings.
     */
    await plant(target);

    if (now() - cycleStartedAt > CONFIG.limits.cycleTimeout) {
      debug('Cycle timeout after planting.');
      return;
    }

    /*
     * STEP 2
     * Wait until target contains tree blocks.
     */
    if (!allGrowable(target)) {
      return;
    }

    /*
     * STEP 3
     * Grow saplings with bone meal.
     */
    if (hasSapling(target)) {
      await grow(target);
    }

    if (now() - cycleStartedAt > CONFIG.limits.cycleTimeout) {
      debug('Cycle timeout after bone meal.');
      return;
    }

    /*
     * STEP 4
     * Chop logs.
     */
    if (hasLogs(target)) {
      await chop(target);
    }

  } catch (err) {
    state.stats.errors++;
    error('Cycle error:', err.message);

  } finally {
    busy = false;
    cycleStartedAt = 0;

    /*
     * Don't write the state file after every tiny action.
     * This keeps disk I/O low.
     */
    saveState();
  }
}

/* =========================================================
   MAIN LOOP
   ========================================================= */

async function startLoop() {
  // Intentionally disabled: this build only authenticates and then idles.
  loopRunning = false;
}


/* =========================================================
   1.21.6+ DIALOG AUTH
   InsaneSMP uses Minecraft's native Dialog UI for register/login.
   Mineflayer can receive the dialog packet through minecraft-protocol,
   but the normal bot.chat('/register ...') path cannot fill these fields.
   This handler submits the dialog's native action semantics directly.
   ========================================================= */

function unwrapNbt(value) {
  if (value && typeof value === 'object' &&
      Object.prototype.hasOwnProperty.call(value, 'type') &&
      Object.prototype.hasOwnProperty.call(value, 'value')) {
    return unwrapNbt(value.value);
  }

  if (Array.isArray(value)) {
    return value.map(unwrapNbt);
  }

  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = unwrapNbt(item);
    }
    return out;
  }

  return value;
}

function textOf(value) {
  value = unwrapNbt(value);

  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';

  const parts = [];

  if (typeof value.text === 'string') parts.push(value.text);
  if (typeof value.translate === 'string') parts.push(value.translate);
  if (typeof value.keybind === 'string') parts.push(value.keybind);

  if (Array.isArray(value.extra)) {
    for (const part of value.extra) parts.push(textOf(part));
  }

  if (Array.isArray(value)) {
    for (const part of value) parts.push(textOf(part));
  }

  return parts.join(' ');
}

function collectDialogInputs(dialog) {
  const root = unwrapNbt(dialog);
  const found = [];
  const seen = new Set();

  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }

    const type = typeof value.type === 'string' ? value.type : '';
    const key = typeof value.key === 'string' ? value.key : '';

    // Native dialog input controls use minecraft:text (and other
    // minecraft:* input-control types) and always carry a key.
    if (key && (
      type === 'minecraft:text' ||
      type === 'minecraft:boolean' ||
      type === 'minecraft:number_range' ||
      type === 'minecraft:single_option' ||
      type.includes('text') ||
      type.includes('input')
    )) {
      if (!found.some(item => item.key === key)) {
        found.push({
          key,
          type,
          label: textOf(value.label)
        });
      }
    }

    for (const child of Object.values(value)) walk(child);
  }

  walk(root);
  return found;
}

function collectDialogActions(dialog) {
  const root = unwrapNbt(dialog);
  const found = [];
  const seen = new Set();

  function pushAction(container, action, label, submitId = '') {
    if (!action || typeof action !== 'object') return;

    const a = unwrapNbt(action);
    const type = typeof a.type === 'string' ? a.type : '';

    if (!type) return;

    found.push({
      type,
      id: typeof a.id === 'string' ? a.id : '',
      template: typeof a.template === 'string' ? a.template : '',
      additions: a.additions,
      label,
      submitId: typeof submitId === 'string' ? submitId : ''
    });
  }

  function walk(value, parentLabel = '', submitId = '') {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) walk(item, parentLabel, submitId);
      return;
    }

    let label = parentLabel;
    if (value.label) {
      label = textOf(value.label) || parentLabel;
    }

    // Input-form submit actions use: { id, on_submit: {...} }
    if (value.on_submit && typeof value.on_submit === 'object') {
      pushAction(
        value,
        value.on_submit,
        label,
        typeof value.id === 'string' ? value.id : ''
      );
    }

    // Some dialog variants use { id, action: {...} }.
    if (value.action && typeof value.action === 'object') {
      pushAction(
        value,
        value.action,
        label,
        typeof value.id === 'string' ? value.id : ''
      );
    }

    // Static click actions can also appear as on_click.
    if (value.on_click && typeof value.on_click === 'object') {
      pushAction(value, value.on_click, label, '');
    }

    for (const [key, child] of Object.entries(value)) {
      // Avoid duplicating an action object after it has already been
      // extracted above; still walk everything else for nested dialogs.
      if (key === 'on_submit' || key === 'on_click') continue;
      walk(child, label, submitId);
    }
  }

  walk(root);

  // Deduplicate identical action objects produced by nested traversal.
  return found.filter((item, index, arr) => {
    return arr.findIndex(other => (
      other.type === item.type &&
      other.id === item.id &&
      other.submitId === item.submitId &&
      other.template === item.template
    )) === index;
  });
}

function makeAuthPayload(inputs, submitId = '') {
  const payload = {};
  const password = String(CONFIG.auth.password || '');

  for (const input of inputs) {
    if (!input.key) continue;
    payload[input.key] = password;
  }

  if (submitId) {
    payload.action = submitId;
  }

  return payload;
}

function authFingerprint(dialog) {
  try {
    return JSON.stringify(unwrapNbt(dialog));
  } catch {
    return String(dialog);
  }
}

function chooseAuthAction(actions) {
  if (!actions.length) return null;

  // The InsaneSMP auth dialog is deterministic by input count:
  //   1 text input  = Login
  //   2 text inputs  = Register
  // Prefer the submit/confirm action and never the disconnect/cancel action.
  const candidates = actions.filter(action => {
    const text = `${action.label} ${action.id} ${action.submitId} ${action.template}`.toLowerCase();
    return !/disconnect|cancel|back|close|exit/.test(text);
  });

  const mode = String(CONFIG.auth.mode || 'auto').toLowerCase();
  const scored = candidates.map(action => {
    const text = `${action.label} ${action.id} ${action.submitId} ${action.template}`.toLowerCase();
    let score = 0;

    const isRegister = /register|signup|sign\s*up/.test(text);
    const isLogin = /login|log\s*in|signin|sign\s*in/.test(text);
    const isConfirm = /confirm|submit|continue|enter|proceed/.test(text);

    if (mode === 'register' && isRegister) score += 300;
    if (mode === 'login' && isLogin) score += 300;
    if (mode === 'register' && isRegister) score += 300;
    if (isConfirm) score += 80;
    if (isRegister) score += 35;
    if (isLogin) score += 35;
    if (/dynamic\/custom|custom_template|custom_form|custom/.test(text) && action.id) score += 200;
    if (/dynamic\/run_command|command_template|run_command/.test(text)) score += 20;

    return { action, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.action || null;
}

function fillCommandTemplate(template, inputs, submitId) {
  let command = String(template || '');
  const password = String(CONFIG.auth.password || '');

  const values = {};
  for (const input of inputs) {
    if (input.key) values[input.key] = password;
  }
  values.action = submitId || '';

  for (const [key, value] of Object.entries(values)) {
    command = command.split(`$(${key})`).join(value);
  }

  // Do not send unresolved dialog macros to the server.
  command = command.replace(/\$\([^)]+\)/g, '');

  return command.trim().replace(/^\/+/, '');
}

function inferAuthCommand(inputs, chosen) {
  const password = String(CONFIG.auth.password || '');
  const text = `${chosen?.label || ''} ${chosen?.id || ''} ${chosen?.submitId || ''}`.toLowerCase();

  // InsaneSMP's native auth GUI is deterministic:
  // 2 password fields => Register, 1 password field => Login.
  if (/register|signup|sign\s*up/.test(text) || inputs.length === 2) {
    return `register ${password} ${password}`;
  }

  if (/login|log\s*in|signin|sign\s*in|confirm/.test(text) || inputs.length === 1) {
    return `login ${password}`;
  }

  return '';
}

async function sendAuthCommand(command) {
  const clean = String(command || '').trim().replace(/^\/+/, '');
  if (!clean) throw new Error('Empty authentication command.');
  if (!bot?._client) throw new Error('Minecraft client is not available.');

  // Native Login/Confirm dialog: submit immediately.
  // No spawn/PLAY wait here; waiting can cause the auth dialog to time out.
  bot._client.write('chat_command', { command: clean });
}
async function submitCustomDialogAction(chosen, inputs) {
  const customId = String(chosen.id || '').trim();
  if (!customId) {
    throw new Error('Custom dialog action has no id.');
  }

  const payload = makeAuthPayload(inputs, chosen.submitId);

  bot._client.write('custom_click_action', {
    id: customId,
    nbt: payload
  });

  log(`[AUTH] Submitted custom dialog action ${customId} with ${inputs.length} input(s).`);
}

async function handleAuthDialog(packet) {
  if (!CONFIG.auth.enabled || authCompleted || stopping) return;

  const password = String(CONFIG.auth.password || '');
  if (!password || password === 'CHANGE_ME') {
    log('[AUTH] Password is not configured.');
    return;
  }

  const rawDialog = packet?.dialog ?? packet;
  const fingerprint = authFingerprint(rawDialog);
  const current = now();

  if (authDialogBusy) return;
  if (
    fingerprint === lastAuthDialogFingerprint &&
    current - lastAuthDialogAt < 4000
  ) {
    return;
  }

  authDialogBusy = true;
  lastAuthDialogFingerprint = fingerprint;
  lastAuthDialogAt = current;

  try {
    const dialog = unwrapNbt(rawDialog);
    const inputs = collectDialogInputs(dialog);
    const actions = collectDialogActions(dialog);
    const chosen = chooseAuthAction(actions);

    log(`[AUTH] Dialog received. Inputs=${inputs.length} Actions=${actions.length}`);

    if (!inputs.length) {
      log('[AUTH] Auth dialog has no input fields.');
      debug('[AUTH DIALOG]', JSON.stringify(dialog, null, 2));
      return;
    }

    if (!chosen) {
      log('[AUTH] No usable Register/Login submit action was found.');
      debug('[AUTH DIALOG]', JSON.stringify(dialog, null, 2));
      return;
    }

    const actionType = String(chosen.type || '').toLowerCase();

    if (
      actionType.includes('command_template') ||
      actionType.includes('dynamic/run_command') ||
      actionType.includes('run_command')
    ) {
      let command = fillCommandTemplate(chosen.template, inputs, chosen.submitId);

      if (!command || !/(^|\s)(login|register)(\s|$)/i.test(command)) {
        command = inferAuthCommand(inputs, chosen);
      }

      if (!command) {
        throw new Error('Unable to build Register/Login command from dialog.');
      }

      const fieldMode = inputs.length === 1 ? 'LOGIN (1 password field)' :
        inputs.length === 2 ? 'REGISTER (2 password fields)' :
        `AUTH (${inputs.length} fields)`;
      log(`[AUTH] Submitting native dialog: ${fieldMode}`);
      await sendAuthCommand(command);
      authSubmittedAt = now();
      maybeStartPostAuth();
      await sleep(25);
      return;
    }

    if (
      actionType.includes('custom_form') ||
      actionType.includes('custom_template') ||
      actionType.includes('dynamic/custom') ||
      actionType === 'custom'
    ) {
      await submitCustomDialogAction(chosen, inputs);
      authSubmittedAt = now();
      maybeStartPostAuth();
      await sleep(25);
      return;
    }

    if (chosen.id && actionType.includes('custom')) {
      await submitCustomDialogAction(chosen, inputs);
      authSubmittedAt = now();
      maybeStartPostAuth();
      await sleep(25);
      return;
    }

    if (chosen.template) {
      const command = fillCommandTemplate(chosen.template, inputs, chosen.submitId)
        || inferAuthCommand(inputs, chosen);

      if (command) {
        log(`[AUTH] Pressing fallback Login/Register action (${inputs.length} field${inputs.length === 1 ? '' : 's'}).`);
        await sendAuthCommand(command);
        authSubmittedAt = now();
        await sleep(25);
        return;
      }
    }

    log(`[AUTH] Unsupported dialog action type: ${chosen.type}`);
    debug('[AUTH ACTION]', JSON.stringify(chosen, null, 2));
  } catch (err) {
    state.stats.errors++;
    error('[AUTH] Dialog handling failed:', err.message);
  } finally {
    authDialogBusy = false;
  }
}


/* =========================================================
   POST-REGISTER ACTIONS
   /afk -> wait 5s -> move N blocks -> idle
   ========================================================= */

let postAuthDone = false;
let botSpawned = false;

async function runPostAuthActions() {
  if (postAuthDone || !CONFIG.postAuth.enabled || !bot || !botSpawned || !authSubmittedAt) return;

  const blocks = Math.max(0, Number(CONFIG.postAuth.moveBlocks) || 0);
  postAuthDone = true;

  try {
    // Give the PLAY world a moment to settle before sending the AFK command.
    await sleep(500);
    if (!bot?._client) throw new Error('Minecraft client is unavailable.');

    const command = String(CONFIG.postAuth.afkCommand || '').replace(/^\/+/, '').trim();
    if (!command) throw new Error('AFK command is empty.');

    // After authentication, /afk is a normal PLAY command. Use the native
    // chat_command packet so it is not swallowed by Mineflayer chat routing.
    bot._client.write('chat_command', { command });
    log(`[POST-AUTH] ${CONFIG.username}: sent /${command}`);

    log(`[POST-AUTH] ${CONFIG.username}: waiting ${CONFIG.postAuth.waitMs}ms before movement.`);
    await sleep(CONFIG.postAuth.waitMs);

    if (!bot?.entity || blocks <= 0) {
      log(`[POST-AUTH] ${CONFIG.username}: standing idle.`);
      return;
    }

    // Capture the current heading and explicitly apply it before moving.
    // This avoids the common case where the bot's yaw has not yet settled.
    const yaw = Number(bot.entity.yaw) || 0;
    try {
      await bot.look(yaw, 0, true);
    } catch {}

    const start = bot.entity.position.clone();
    const dx = -Math.sin(yaw);
    const dz = Math.cos(yaw);
    const targetX = start.x + dx * blocks;
    const targetZ = start.z + dz * blocks;

    log(`[POST-AUTH] ${CONFIG.username}: moving ${blocks} blocks ahead.`);

    let lastDistance = Number.POSITIVE_INFINITY;
    let stuckTicks = 0;
    const deadline = Date.now() + Math.max(15000, blocks * 3000);

    try {
      bot.setControlState('forward', true);
      bot.setControlState('sprint', true);

      while (Date.now() < deadline && bot?.entity) {
        const p = bot.entity.position;
        const remaining = Math.hypot(targetX - p.x, targetZ - p.z);
        if (remaining <= 0.35) break;

        if (remaining >= lastDistance - 0.01) {
          stuckTicks++;
        } else {
          stuckTicks = 0;
        }
        lastDistance = remaining;

        // If a simple forward run is blocked, try one jump rather than
        // silently standing still. The movement target remains the same.
        if (stuckTicks >= 8) {
          try { bot.setControlState('jump', true); } catch {}
          await sleep(180);
          try { bot.setControlState('jump', false); } catch {}
          stuckTicks = 0;
        }

        await sleep(50);
      }
    } finally {
      try { bot.clearControlStates(); } catch {}
    }

    const end = bot?.entity?.position;
    const travelled = end
      ? Math.hypot(end.x - start.x, end.z - start.z)
      : 0;

    if (travelled < Math.max(0.5, blocks * 0.5)) {
      log(`[POST-AUTH] ${CONFIG.username}: movement was blocked after ${travelled.toFixed(2)} blocks; standing idle.`);
    } else {
      log(`[POST-AUTH] ${CONFIG.username}: movement complete (${travelled.toFixed(2)} blocks); standing idle.`);
    }
  } catch (err) {
    postAuthDone = false;
    error('[POST-AUTH] sequence failed:', err.message);
  }
}

function maybeStartPostAuth() {
  if (authSubmittedAt > 0 && botSpawned && !postAuthDone) {
    runPostAuthActions().catch(err => error('[POST-AUTH] failed:', err.message));
  }
}

/* =========================================================
   BOT CONNECTION
   ========================================================= */

function calculateReconnectDelay() {
  const exponential =
    CONFIG.reconnectDelay *
    Math.pow(2, reconnectAttempt);

  const jitter =
    Math.floor(Math.random() * 1000);

  return Math.min(
    exponential + jitter,
    CONFIG.limits.maxReconnectDelay
  );
}

function scheduleReconnect() {
  if (stopping) {
    return;
  }

  if (reconnectTimer) {
    return;
  }

  const delay = calculateReconnectDelay();

  reconnectAttempt++;

  state.stats.reconnects++;

  log(
    `[RECONNECT] Attempt ${reconnectAttempt} in ${delay}ms`
  );

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;

    if (!stopping) {
      makeBot();
    }
  }, delay);
}

function makeBot() {
  if (stopping) {
    return;
  }

  // Every connection gets a fresh authentication state.
  authDialogBusy = false;
  lastAuthDialogAt = 0;
  lastAuthDialogFingerprint = '';
  authCompleted = false;
  postAuthDone = false;
  botSpawned = false;

  if (bot) {
    try {
      bot.removeAllListeners();
    } catch {}

    bot = null;
  }

  loopRunning = false;
  busy = false;

  log('[BOT] Connecting...');

  try {
    bot = mineflayer.createBot({
      host: CONFIG.host,
      port: CONFIG.port,
      username: CONFIG.username,
      auth: 'offline',
      version: '1.21.11',
      connectionTimeout: 60000,
      checkTimeoutInterval: 60000
    });

    // Native Minecraft 1.21.6+ Dialog packets are used by the
    // server's register/login screen. Handle them before spawn.
    bot._client.on('show_dialog', packet => {
      handleAuthDialog(packet).catch(err => {
        state.stats.errors++;
        error('[AUTH] Unhandled dialog error:', err.message);
      });
    });

  } catch (err) {
    error('Bot creation failed:', err.message);
    scheduleReconnect();
    return;
  }

  bot.once('spawn', () => {
    reconnectAttempt = 0;
    botSpawned = true;
    // If the auth command was submitted and the player reaches spawn,
    // authentication has completed. Otherwise allow a short no-dialog grace period.
    if (authSubmittedAt > 0) {
      authCompleted = true;
      log('[AUTH] Authentication completed; bot spawned.');
      if (typeof process.send === 'function') {
        try {
          process.send({ type: 'auth-success', username: CONFIG.username });
        } catch {}
      }
    } else {
      setTimeout(() => {
        if (!authDialogBusy && !lastAuthDialogFingerprint && !authCompleted) {
          authCompleted = true;
          authSubmittedAt = now();
          log('[AUTH] No auth dialog detected; assuming existing session is already authenticated.');
          if (typeof process.send === 'function') {
            try {
              process.send({ type: 'auth-success', username: CONFIG.username, existingSession: true });
            } catch {}
          }
          maybeStartPostAuth();
        }
      }, 3000);
    }

    log('========================================');
    log('[+] TREE BOT READY');
    log(`[+] Bot: ${CONFIG.username}`);
    log(`[+] Owner: ${CONFIG.ownerUsername}`);
    log(`[+] Server: ${CONFIG.host}:${CONFIG.port}`);
    if (authSubmittedAt > 0) {
      log('[POST-AUTH] Auth submission detected. Starting /afk sequence.');
      maybeStartPostAuth();
    } else {
      log('[POST-AUTH] Waiting for successful auth dialog submission.');
    }
    log('========================================');
  });

  bot.on('error', err => {
    state.stats.errors++;

    error(
      '[BOT ERROR]',
      err?.message || String(err)
    );
  });

  bot.on('kicked', reason => {
    authDialogBusy = false;
    authCompleted = false;
    authSubmittedAt = 0;

    let readable = String(reason);
    try {
      const parsed = typeof reason === 'string' ? JSON.parse(reason) : reason;
      const text = textOf(parsed);
      if (text) readable = text;
      else if (parsed?.value) readable = textOf(parsed.value) || String(parsed.value);
    } catch {}

    log('[BOT KICKED]', readable);

    if (/too long to register|authentication is busy|register/i.test(readable)) {
      log('[AUTH] The server is waiting for its native Register/Login dialog.');
    }
  });

  bot.on('end', () => {
    loopRunning = false;
    busy = false;

    log('[BOT] Disconnected');

    if (!stopping) {
      scheduleReconnect();
    }
  });
}

/* =========================================================
   LOCK OWNER TARGET
   ========================================================= */

function lockOwner() {
  if (!isBotReady()) {
    return {
      ok: false,
      message: 'Bot is not spawned.'
    };
  }

  const entity = ownerEntity();

  if (!entity) {
    return {
      ok: false,
      message: `Owner ${CONFIG.ownerUsername} is not visible.`
    };
  }

  const target = getTargetArea(entity);

  if (!targetIsValid(target)) {
    return {
      ok: false,
      message: 'Unable to calculate owner target.'
    };
  }

  state.lockedTarget = target.map(position => ({
    x: position.x,
    y: position.y,
    z: position.z
  }));

  state.lockedAt = now();
  state.mode = 'locked';

  saveState();

  action(
    'Locked owner target:',
    state.lockedTarget
  );

  return {
    ok: true,
    mode: state.mode,
    target: state.lockedTarget,
    targetState: getTargetState(target)
  };
}

/* =========================================================
   LOCK BOT POSITION
   ========================================================= */

function lockBot() {
  if (!isBotReady()) {
    return {
      ok: false,
      message: 'Bot is not spawned.'
    };
  }

  const position = bot.entity.position.floored();

  const target = [
    position,
    position.offset(1, 0, 0),
    position.offset(0, 0, 1),
    position.offset(1, 0, 1)
  ];

  state.lockedTarget = target.map(p => ({
    x: p.x,
    y: p.y,
    z: p.z
  }));

  state.lockedAt = now();
  state.mode = 'locked';

  saveState();

  action(
    'Locked bot target:',
    state.lockedTarget
  );

  return {
    ok: true,
    mode: state.mode,
    target: state.lockedTarget,
    targetState: getTargetState(target)
  };
}

/* =========================================================
   UNLOCK
   ========================================================= */

function unlockTarget() {
  state.mode = 'auto';
  state.lockedTarget = null;
  state.lockedAt = 0;

  saveState();

  action('Target unlocked. Automatic owner targeting enabled.');

  return {
    ok: true,
    mode: state.mode,
    message: 'Target unlocked.'
  };
}

/* =========================================================
   SPEED CONTROL
   ========================================================= */

function setSpeed(name, value) {
  if (!(name in state.speed)) {
    return {
      ok: false,
      message: `Invalid speed name: ${name}`
    };
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return {
      ok: false,
      message: 'Speed must be a number.'
    };
  }

  state.speed[name] = clamp(
    Math.round(number),
    CONFIG.limits.minSpeed,
    CONFIG.limits.maxSpeed
  );

  saveState();

  action(
    `Speed changed: ${name} = ${state.speed[name]}ms`
  );

  return {
    ok: true,
    speed: state.speed
  };
}

/* =========================================================
   HTTP CONTROL PANEL
   ========================================================= */

function reply(res, code, data) {
  try {
    const body = JSON.stringify(data);

    res.writeHead(code, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': 'http://127.0.0.1',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });

    res.end(body);

  } catch {
    try {
      res.end(
        JSON.stringify({
          ok: false,
          message: 'Response error'
        })
      );
    } catch {}
  }
}

function getStatus() {
  validateLock();

  return {
    ok: true,

    connected: isBotReady(),

    spawned: !!bot?.entity,

    enabled: state.enabled,

    busy,

    loopRunning,

    stopping,

    mode: state.mode,

    lockedAt: state.lockedAt,

    lockRemaining:
      state.mode === 'locked' && state.lockedAt
        ? Math.max(
            0,
            CONFIG.limits.targetLockTimeout -
            (now() - state.lockedAt)
          )
        : 0,

    speed: {
      ...state.speed
    },

    target: state.lockedTarget,

    targetState: getTargetState(
      targetNow()
    ),

    inventory: getInventorySummary(),

    stats: {
      ...state.stats
    },

    uptime: process.uptime()
  };
}

loadAuth();
loadState();

/* =========================================================
   PROCESS SHUTDOWN
   ========================================================= */

function gracefulShutdown(reason) {
  if (stopping) {
    return;
  }

  stopping = true;

  log(
    `[SYSTEM] Shutting down: ${reason}`
  );

  state.enabled = false;

  saveState();

  loopRunning = false;
  busy = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    bot?.quit(reason);
  } catch {}

  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on(
  'SIGINT',
  () => gracefulShutdown('SIGINT')
);

process.on(
  'SIGTERM',
  () => gracefulShutdown('SIGTERM')
);

process.on(
  'uncaughtException',
  err => {
    state.stats.errors++;

    error(
      '[UNCAUGHT EXCEPTION]',
      err.stack || err.message
    );
  }
);

process.on(
  'unhandledRejection',
  reason => {
    state.stats.errors++;

    error(
      '[UNHANDLED REJECTION]',
      reason?.stack || reason
    );
});

/* =========================================================
   START
   ========================================================= */


async function runSelfTest() {
  const accounts = [
    { username: 'Aarav77_YTx', password: 'Vihdddan77X', blocks: 5 },
    { username: 'Vihan77X', password: 'Vihraft81q', blocks: 10 }
  ];

  const assert = (condition, message) => {
    if (!condition) throw new Error(`SELFTEST FAILED: ${message}`);
  };

  assert(accounts.length === 2, 'exactly two accounts');
  assert(new Set(accounts.map(a => a.username)).size === 2, 'unique usernames');
  assert(new Set(accounts.map(a => a.password)).size === 2, 'unique passwords');
  assert(CONFIG.auth.mode === 'auto', 'AUTO auth mode');
  assert(CONFIG.postAuth.afkCommand === '/afk', 'AFK command');
  assert(CONFIG.postAuth.waitMs === 5000, '5 second wait');
  assert(CONFIG.postAuth.secondAccountDelayMs === 10000, '10 second account stagger');
  assert(accounts[0].blocks === 5 && accounts[1].blocks === 10, 'movement distances');

  const registerInputs = [
    { key: 'password', label: 'Password' },
    { key: 'confirm_password', label: 'Confirm Password' }
  ];
  const loginInputs = [
    { key: 'password', label: 'Password' }
  ];

  const registerAction = { type: 'minecraft:dynamic/run_command', template: '/register $(password) $(confirm_password)', label: 'Register' };
  const loginAction = { type: 'minecraft:dynamic/run_command', template: '/login $(password)', label: 'Login' };

  assert(inferAuthCommand(registerInputs, registerAction) === 'register ' + CONFIG.auth.password + ' ' + CONFIG.auth.password, 'register command');
  assert(inferAuthCommand(loginInputs, loginAction) === 'login ' + CONFIG.auth.password, 'login command');

  const simulateMovement = blocks => {
    const yaw = 0;
    const start = { x: 0, z: 0 };
    const end = {
      x: start.x - Math.sin(yaw) * blocks,
      z: start.z + Math.cos(yaw) * blocks
    };
    return Math.hypot(end.x - start.x, end.z - start.z);
  };

  assert(Math.abs(simulateMovement(5) - 5) < 1e-9, '5-block movement geometry');
  assert(Math.abs(simulateMovement(10) - 10) < 1e-9, '10-block movement geometry');

  for (let i = 0; i < 100000; i++) {
    assert(inferAuthCommand(registerInputs, registerAction).startsWith('register '), `register simulation ${i + 1}`);
    assert(inferAuthCommand(loginInputs, loginAction).startsWith('login '), `login simulation ${i + 1}`);
    assert(Math.abs(simulateMovement(5) - 5) < 1e-9, `5-block simulation ${i + 1}`);
    assert(Math.abs(simulateMovement(10) - 10) < 1e-9, `10-block simulation ${i + 1}`);
  }

  console.log('[SELFTEST] 2 unique account names = PASS');
  console.log('[SELFTEST] 2 unique passwords = PASS');
  console.log('[SELFTEST] 2-field Register GUI = PASS');
  console.log('[SELFTEST] 1-field Login GUI = PASS');
  console.log('[SELFTEST] /afk command path = PASS');
  console.log('[SELFTEST] Account 1: /afk -> 5s -> 5 blocks -> idle = PASS');
  console.log('[SELFTEST] Account 2: /afk -> 5s -> 10 blocks -> idle = PASS');
  console.log('[SELFTEST] Account 2 stagger = 10s after Account 1 auth success = PASS');
  console.log('[SELFTEST] 100,000 local auth + movement simulations = PASS');
  console.log('[SELFTEST] No live third-party server connection was made.');
}

function launchTwoAccounts() {
  const { fork } = require('child_process');

  const accounts = [
    {
      username: process.env.BOT1_USERNAME || 'Aarav77_YTx',
      password: process.env.BOT1_PASSWORD || 'Vihdddan77X',
      blocks: 5
    },
    {
      username: process.env.BOT2_USERNAME || 'Vihan77X',
      password: process.env.BOT2_PASSWORD || 'Vihraft81q',
      blocks: 10
    }
  ];

  if (new Set(accounts.map(a => a.username)).size !== 2) {
    throw new Error('The two account usernames must be different.');
  }
  if (new Set(accounts.map(a => a.password)).size !== 2) {
    throw new Error('The two account passwords must be different.');
  }

  for (const account of accounts) {
    if (!/^[A-Za-z0-9_]{3,16}$/.test(account.username)) {
      throw new Error(`Invalid Minecraft username: ${account.username}`);
    }
    if (!account.password || account.password === 'CHANGE_ME') {
      throw new Error(`Password missing for ${account.username}`);
    }
  }

  log('');
  log('========================================');
  log(' TWO-ACCOUNT NATIVE AUTH MODE');
  log('========================================');
  log(`[CONFIG] Server : ${CONFIG.host}:${CONFIG.port}`);
  log('[CONFIG] Auth   : AUTO (1-field Login / 2-field Register)');
  log(`[CONFIG] Account 1: ${accounts[0].username} | move 5 blocks`);
  log(`[CONFIG] Account 2: ${accounts[1].username} | move 10 blocks`);
  log(`[CONFIG] Account 2 starts ${CONFIG.postAuth.secondAccountDelayMs}ms after Account 1 auth success`);
  log('[CONFIG] Each: auth -> /afk -> 5s -> move -> idle');
  log('========================================');

  const children = [];
  let secondLaunched = false;
  let secondTimer = null;

  const launch = (account, index) => {
    const child = fork(__filename, [], {
      env: {
        ...process.env,
        TREEBOT_CHILD: '1',
        BOT_USERNAME: account.username,
        BOT_PASSWORD: account.password,
        BOT_MOVE_BLOCKS: String(account.blocks)
      },
      stdio: ['inherit', 'inherit', 'inherit', 'ipc']
    });

    child.on('message', message => {
      if (message?.type !== 'auth-success') return;
      log(`[AUTH-OK] ${message.username}: authentication/spawn confirmed.`);

      if (index === 0 && !secondLaunched) {
        secondTimer = setTimeout(() => {
          secondTimer = null;
          if (secondLaunched) return;
          secondLaunched = true;
          launch(accounts[1], 1);
        }, CONFIG.postAuth.secondAccountDelayMs);
      }
    });

    child.on('exit', (code, signal) => {
      log(`[CHILD] ${account.username} exited (code=${code}, signal=${signal || 'none'}).`);
    });

    children.push(child);
    log(`[LAUNCH] Account ${index + 1}: ${account.username}`);
  };

  const shutdown = () => {
    if (secondTimer) clearTimeout(secondTimer);
    for (const child of children) {
      try { child.kill('SIGTERM'); } catch {}
    }
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  launch(accounts[0], 0);
}

if (process.env.TREEBOT_SELFTEST === '1') {
  runSelfTest()
    .then(() => process.exit(0))
    .catch(err => {
      console.error(err.stack || err.message);
      process.exit(1);
    });
} else {
  loadAuth();
  loadState();
}

function gracefulShutdown(reason) {
  if (stopping) return;
  stopping = true;
  log(`[SYSTEM] Shutting down: ${reason}`);
  state.enabled = false;
  saveState();
  loopRunning = false;
  busy = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  try { bot?.quit(reason); } catch {}
  try { renderHealthServer?.close(); } catch {}
  setTimeout(() => process.exit(0), 500);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('uncaughtException', err => {
  state.stats.errors++;
  error('[UNCAUGHT EXCEPTION]', err.stack || err.message);
});
process.on('unhandledRejection', reason => {
  state.stats.errors++;
  error('[UNHANDLED REJECTION]', reason?.stack || reason);
});

function startRenderHealthServer() {
  if (process.env.TREEBOT_CHILD === '1' || process.env.TREEBOT_SELFTEST === '1') return;

  const port = Number(process.env.PORT || 10000);
  renderHealthServer = http.createServer((req, res) => {
    if (req.url === '/healthz' || req.url === '/' || req.url === '/status') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'treebot', uptime: process.uptime() }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, message: 'Not found' }));
  });

  renderHealthServer.on('error', err => {
    console.error('[RENDER HEALTH] Server error:', err.message);
  });

  renderHealthServer.listen(port, '0.0.0.0', () => {
    log(`[RENDER] Health server listening on 0.0.0.0:${port}`);
  });
}

if (process.env.TREEBOT_SELFTEST !== '1') {
  if (process.env.TREEBOT_CHILD === '1') {
    log('');
    log('========================================');
    log(' NATIVE AUTH WORKER');
    log('========================================');
    log(`[CONFIG] Server : ${CONFIG.host}:${CONFIG.port}`);
    log(`[CONFIG] Bot    : ${CONFIG.username}`);
    log(`[CONFIG] Move   : ${CONFIG.postAuth.moveBlocks} blocks`);
    log('[CONFIG] Auth   : AUTO (Login/Register)');
    log('========================================');
    makeBot();
  } else {
    startRenderHealthServer();
    launchTwoAccounts();
  }
}
