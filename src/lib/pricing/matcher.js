// Pure pricing-lookup logic. No I/O, no async. Tested in isolation.
//
// Resolve order:
//   1. CURATED exact match (self-defined aliases like kiro-*, hy3-*)
//   2. LiteLLM exact match (mainstream claude/gpt-5/gemini)
//   3. CURATED alias (e.g. "auto" -> "composer-1")
//   4. CURATED fuzzy substring (e.g. "kiro-future-xyz" matches via "kiro")
//   5. LiteLLM suffix-strip (gpt-5-codex-high-fast -> gpt-5-codex)
//   6. LiteLLM reverse substring (longest-key first)
//   7. null  (caller decides what to do — typically zero-pricing + negative cache)

const SUFFIX_STRIP_PATTERNS = [
  /-xhigh-fast$/,
  /-high-fast$/,
  /-medium-fast$/,
  /-low-fast$/,
  /-xhigh$/,
  /-high$/,
  /-medium$/,
  /-low$/,
  /-fast$/,
];

function stripReasoningSuffix(model) {
  for (const re of SUFFIX_STRIP_PATTERNS) {
    if (re.test(model)) return model.replace(re, "");
  }
  return model;
}

function normalizeAntigravityModel(model) {
  if (!model || typeof model !== "string") return model;
  let lower = model
    .trim()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\b(thinking|xhigh|high|medium|low|fast)\b/gi, " ")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  lower = stripReasoningSuffix(lower);

  if (lower.startsWith("gemini-claude-") || lower.startsWith("gemini-gpt-")) {
    lower = lower.substring(7);
  }

  if (/^gemini-3\.\d+-flash-lite/.test(lower)) return "gemini-2.5-flash-lite";
  if (/^gemini-3\.\d+-flash/.test(lower)) return "gemini-2.5-flash";
  if (/^gemini-3\.\d+-pro/.test(lower)) return "gemini-2.5-pro";
  if (/^claude-(sonnet|opus|haiku)-4\.\d+/.test(lower)) {
    return lower.replace(/^claude-(sonnet|opus|haiku)-4\.(\d+)/, "claude-$1-4-$2");
  }
  if (lower.startsWith("gpt-oss-120b")) return "antigravity-gpt-oss-120b";

  return lower;
}

function shouldNormalizeAntigravity(source) {
  return typeof source === "string" && source.toLowerCase() === "antigravity";
}

// Memoise the sorted-by-length LiteLLM key list. Reverse-substring scan walks
// this once per uncached model; ~2k keys × negligible per-iteration cost, but
// computing the sort on every call would add up across a sync.
const sortedKeysCache = new WeakMap();
function getSortedKeys(litellm) {
  let cached = sortedKeysCache.get(litellm);
  if (!cached) {
    cached = Object.keys(litellm).sort((a, b) => b.length - a.length);
    sortedKeysCache.set(litellm, cached);
  }
  return cached;
}

function lookupPricing(model, { curated, litellm, source } = {}) {
  if (!model || typeof model !== "string") {
    return { hit: false, source: "empty", value: null };
  }
  const lookupModel = shouldNormalizeAntigravity(source)
    ? normalizeAntigravityModel(model)
    : model;
  const lower = lookupModel.toLowerCase();

  // 1. CURATED exact
  if (curated.exact && curated.exact[lookupModel]) {
    return { hit: true, source: "curated:exact", value: curated.exact[lookupModel] };
  }

  // 2. LiteLLM exact
  if (litellm && litellm[lookupModel]) {
    return { hit: true, source: "litellm:exact", value: litellm[lookupModel] };
  }

  // 3. CURATED alias (literal mapping like "auto" -> "composer-1")
  if (curated.alias && curated.alias[lookupModel] && curated.exact[curated.alias[lookupModel]]) {
    return {
      hit: true,
      source: "curated:alias",
      value: curated.exact[curated.alias[lookupModel]],
    };
  }

  // 4. CURATED fuzzy substring
  if (Array.isArray(curated.fuzzy)) {
    for (const { match, ref } of curated.fuzzy) {
      if (!match || !ref) continue;
      if (lower.includes(match.toLowerCase()) && curated.exact[ref]) {
        return { hit: true, source: "curated:fuzzy", value: curated.exact[ref] };
      }
    }
  }

  // 5. LiteLLM suffix-strip
  if (litellm) {
    const stripped = stripReasoningSuffix(lookupModel);
    if (stripped !== lookupModel && litellm[stripped]) {
      return { hit: true, source: "litellm:strip", value: litellm[stripped] };
    }
  }

  // 6. LiteLLM reverse substring (longest-key first)
  if (litellm) {
    const sorted = getSortedKeys(litellm);
    for (const key of sorted) {
      const keyLower = key.toLowerCase();
      // Only accept if model is a superset of key (model contains key), to
      // avoid e.g. "gpt-5" matching "gpt-5-pro" in the wrong direction.
      if (lower.includes(keyLower)) {
        return { hit: true, source: "litellm:fuzzy", value: litellm[key] };
      }
    }
  }

  return { hit: false, source: "miss", value: null };
}

// Convert one LiteLLM entry (per-token) to internal per-million USD shape.
// Missing fields stay missing — callers default with `(pricing.x || 0)`.
//
// Why the round: floating-point math means 1e-7 * 1e6 = 0.09999999999999999.
// Rounding to 10 significant decimals ($0.0000000001 / MTok) is well below
// any realistic price step but cleans up the printed/asserted numbers.
function roundToTenDecimals(n) {
  return Math.round(n * 1e10) / 1e10;
}

function convertLitellmEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const out = {};
  if (typeof entry.input_cost_per_token === "number") {
    out.input = roundToTenDecimals(entry.input_cost_per_token * 1_000_000);
  }
  if (typeof entry.output_cost_per_token === "number") {
    out.output = roundToTenDecimals(entry.output_cost_per_token * 1_000_000);
  }
  if (typeof entry.cache_read_input_token_cost === "number") {
    out.cache_read = roundToTenDecimals(entry.cache_read_input_token_cost * 1_000_000);
  }
  if (typeof entry.cache_creation_input_token_cost === "number") {
    out.cache_write = roundToTenDecimals(entry.cache_creation_input_token_cost * 1_000_000);
  }
  return Object.keys(out).length ? out : null;
}

// Build a per-million-USD map from a LiteLLM raw map (or seed snapshot which
// uses the same field names). Skips meta keys starting with "_".
function buildLitellmPerMillionMap(rawData) {
  if (!rawData || typeof rawData !== "object") return {};
  const out = {};
  for (const [name, entry] of Object.entries(rawData)) {
    if (name.startsWith("_")) continue;
    const converted = convertLitellmEntry(entry);
    if (converted) out[name] = converted;
  }
  return out;
}

module.exports = {
  lookupPricing,
  stripReasoningSuffix,
  normalizeAntigravityModel,
  convertLitellmEntry,
  buildLitellmPerMillionMap,
};
