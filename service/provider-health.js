/**
 * provider-health.js - Track per-provider exhaustion state for failover
 *
 * Maintains in-memory health state for each model provider (e.g., "anthropic",
 * "zai-coding-plan"). Callers resolve a priority-ordered list of model strings
 * (e.g., ["anthropic/claude-opus-4-7", "zai-coding-plan/glm-5.1"]) through
 * pickModel() to get the first model whose provider is currently healthy.
 *
 * Exhaustion is detected reactively from opencode session errors. When a
 * provider is marked exhausted, it enters a cooldown period with exponential
 * backoff (5h → 10h → 24h → capped at 1 week). A successful session resets
 * the backoff.
 */

const DEFAULT_INITIAL_COOLDOWN_MS = 5 * 60 * 60 * 1000;
const MAX_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const EXHAUSTION_PATTERNS = [
  /out of extra usage/i,
  /third.?party apps.*extra usage/i,
  /rate.?limit/i,
  /rate_limit_error/i,
  /usage.?limit/i,
  /quota.*exceeded/i,
  /quota.*exhausted/i,
  /insufficient quota/i,
  /plan.*limit.*reached/i,
];

// providerID -> { cooldownUntil: number, cooldownMs: number, lastError: string }
const state = new Map();

export function isExhaustionError(message) {
  if (!message || typeof message !== "string") return false;
  return EXHAUSTION_PATTERNS.some((p) => p.test(message));
}

export function getProviderFromModel(model) {
  if (!model) return null;
  return model.includes("/") ? model.split("/", 2)[0] : "anthropic";
}

export function isProviderHealthy(providerID, now = Date.now()) {
  const entry = state.get(providerID);
  if (!entry) return true;
  return now >= entry.cooldownUntil;
}

export function getProviderState(providerID) {
  return state.get(providerID) || null;
}

export function getAllProviderStates() {
  const out = {};
  for (const [k, v] of state.entries()) out[k] = { ...v };
  return out;
}

export function markExhausted(providerID, options = {}) {
  const now = options.now ?? Date.now();
  const prev = state.get(providerID);
  const initial = options.initialCooldownMs ?? DEFAULT_INITIAL_COOLDOWN_MS;
  const max = options.maxCooldownMs ?? MAX_COOLDOWN_MS;

  let nextCooldown;
  if (prev && now < prev.cooldownUntil + initial) {
    nextCooldown = Math.min(prev.cooldownMs * 2, max);
  } else {
    nextCooldown = initial;
  }

  state.set(providerID, {
    cooldownUntil: now + nextCooldown,
    cooldownMs: nextCooldown,
    lastError: options.reason || "exhaustion detected",
  });

  return state.get(providerID);
}

export function markHealthy(providerID) {
  state.delete(providerID);
}

export function pickModel(chain, now = Date.now()) {
  if (!Array.isArray(chain) || chain.length === 0) return null;
  for (const model of chain) {
    const providerID = getProviderFromModel(model);
    if (isProviderHealthy(providerID, now)) {
      return { model, providerID };
    }
  }
  return null;
}

export function resolveModelChain(config) {
  if (Array.isArray(config?.models) && config.models.length > 0) {
    return config.models.filter(Boolean);
  }
  if (config?.model) {
    return [config.model];
  }
  return [];
}

export function _resetForTests() {
  state.clear();
}
