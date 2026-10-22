import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";

/**
 * All levels the extension knows about, including "off" (Pi's internal state).
 * The slash-command surface intentionally exposes only model reasoning options.
 * `/effort max` stays the highest-level alias. It is not the Pi `max` token.
 */
export const ALL_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ALL_LEVELS_WITHOUT_XHIGH = ["off", "minimal", "low", "medium", "high"] as const;

/** Levels shown to users in usage and tab completion. */
export const USER_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];

/** Semantic aliases that resolve per-model. */
export const SEMANTIC_ALIASES = ["min", "max"] as const;

/**
 * `default` asks the provider for the model's own effort. Pi has no such level: its `off` sends an
 * explicit "no thinking" field (`reasoning.effort: "none"`, `thinking: { type: "disabled" }`, ...).
 * So `default` runs Pi at `off` and `stripThinkingOff()` removes those fields from each request.
 */
export const DEFAULT_TOKEN = "default";

/** Fast mode subcommands. */
export const FAST_MODE_ACTIONS = ["on", "off"] as const;

/** Providers that accept OpenAI `service_tier: "priority"`. */
export const FAST_PROVIDERS = ["openai", "openai-codex", "azure-openai-responses"] as const;

export const FAST_ON_NOTICE =
  'Fast mode ON: OpenAI priority tier (~2x token price / faster Codex quota). Persists until /fast off.';

export type EffortLevel = (typeof ALL_LEVELS)[number];
export type EffortAlias = (typeof SEMANTIC_ALIASES)[number];
export type FastModeAction = (typeof FAST_MODE_ACTIONS)[number];

/**
 * Resolve the Pi ThinkingLevel from our EffortLevel.
 * "off" is not in ThinkingLevel but is valid in Pi's internal state.
 */
export function toThinkingLevel(level: EffortLevel): ThinkingLevel | "off" {
  return level;
}

export function isEffortLevel(value: string): value is EffortLevel {
  return ALL_LEVELS.includes(value as EffortLevel);
}

export function isEffortAlias(value: string): value is EffortAlias {
  return SEMANTIC_ALIASES.includes(value as EffortAlias);
}

/** True when `/fast` may add `service_tier` for this model. */
export function isFastEligible(model: { id?: string; provider?: string } | null | undefined): boolean {
  if (!model?.id || typeof model.provider !== "string") return false;
  if (!(FAST_PROVIDERS as readonly string[]).includes(model.provider)) return false;
  return model.id.startsWith("gpt-5");
}

export type EffortCommand =
  | { kind: "set-session"; level: EffortLevel }
  | { kind: "set-min" }
  | { kind: "set-max" }
  | { kind: "set-default" };

/** What can be remembered per model: a level, or the provider's own default. */
export type EffortChoice = EffortLevel | typeof DEFAULT_TOKEN;

export type FastCommand = { kind: "fast-set"; enabled: boolean } | { kind: "fast-toggle" };

export type EffortModel = Pick<Model<any>, "id" | "reasoning" | "thinkingLevelMap"> & {
  provider?: string;
};

// ─── Suggestion helpers ─────────────────────────────────────────────

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[] = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;

  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j];
      if (a[i - 1] === b[j - 1]) {
        dp[j] = prev;
      } else {
        dp[j] = Math.min(prev + 1, dp[j] + 1, dp[j - 1] + 1);
      }
      prev = temp;
    }
  }
  return dp[n];
}

function suggestClosest(input: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of candidates) {
    const dist = levenshteinDistance(input, candidate);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

/** All tokens valid as the first argument to /effort. */
const EFFORT_TOKEN_CANDIDATES = [...USER_LEVELS, ...SEMANTIC_ALIASES, "off", DEFAULT_TOKEN];

// ─── Parser ─────────────────────────────────────────────────────────

export function parseEffortCommand(args: string): EffortCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length !== 1) {
    throw new Error(USAGE);
  }

  const [first] = tokens;
  if (first === "max") return { kind: "set-max" };
  if (first === "min") return { kind: "set-min" };
  if (first === "off") return { kind: "set-session", level: "off" };
  if (first === DEFAULT_TOKEN) return { kind: "set-default" };
  if (USER_LEVELS.includes(first as ThinkingLevel)) return { kind: "set-session", level: first as EffortLevel };

  const suggestion = suggestClosest(first, EFFORT_TOKEN_CANDIDATES);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown effort level "${first}".${hint}\n${USAGE}`);
}

export function parseFastCommand(args: string): FastCommand {
  const tokens = args.trim().split(/\s+/).filter(Boolean);

  if (tokens.length === 0) return { kind: "fast-toggle" };

  if (tokens.length !== 1) {
    throw new Error(FAST_USAGE);
  }

  const [first] = tokens;
  if (first === "on") return { kind: "fast-set", enabled: true };
  if (first === "off") return { kind: "fast-set", enabled: false };

  const suggestion = suggestClosest(first, FAST_MODE_ACTIONS);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";
  throw new Error(`Unknown fast mode "${first}".${hint}\n${FAST_USAGE}`);
}

// ─── Model capability resolution ────────────────────────────────────

/** Levels available for the given model, including "off". */
export function getAvailableThinkingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  if (!model) return ["off"];
  return getSupportedThinkingLevels(model as Model<any>).filter(isEffortLevel);
}

/** Levels shown to the user for the given model (excludes "off"). */
export function getUserFacingLevels(model: EffortModel | null | undefined): EffortLevel[] {
  return getAvailableThinkingLevels(model).filter((l) => l !== "off");
}

/**
 * Resolve "min" to the lowest reasoning level for the model.
 * Returns undefined for non-reasoning models (thinking unavailable).
 */
export function resolveMinLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  return getUserFacingLevels(model)[0];
}

/**
 * Resolve "max" to the highest available level for the model.
 * Returns undefined for non-reasoning models (thinking unavailable).
 */
export function resolveMaxLevel(model: EffortModel | null | undefined): EffortLevel | undefined {
  if (!model?.reasoning) return undefined;
  const levels = getUserFacingLevels(model);
  return levels[levels.length - 1];
}

/** Resolve a parsed `/effort` command to a level for the model. Undefined: thinking unavailable. */
export function resolveEffortCommand(
  command: EffortCommand,
  model: EffortModel | null | undefined
): EffortLevel | undefined {
  if (command.kind === "set-min") return resolveMinLevel(model);
  if (command.kind === "set-max") return resolveMaxLevel(model);
  if (command.kind === "set-default") return "off";
  return command.level;
}

/** Resolve a user-facing level or semantic alias against the active model. */
export function resolveEffortLevel(
  value: EffortLevel | EffortAlias,
  model: EffortModel | null | undefined
): EffortLevel | undefined {
  if (value === "min") return resolveMinLevel(model);
  if (value === "max") return resolveMaxLevel(model);
  return value;
}

/** Cycle to the next effort level for the given model. Wraps around. */
export function cycleLevel(current: string, model: EffortModel | null | undefined): EffortLevel | undefined {
  const levels = getUserFacingLevels(model);
  if (levels.length === 0) return undefined;
  const idx = levels.indexOf(current as EffortLevel);
  if (idx === -1) return levels[0];
  return levels[(idx + 1) % levels.length];
}

// ─── Settings persistence ───────────────────────────────────────────

export function readSettingsObject(settingsPath: string): Record<string, unknown> {
  try {
    const raw = readFileSync(settingsPath, "utf-8").trim();
    if (raw.length === 0) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    throw new Error("settings.json is not a JSON object");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

function writeSettingsObject(settingsPath: string, settings: Record<string, unknown>): void {
  const content = `${JSON.stringify(settings, null, 2)}\n`;
  let targetPath = settingsPath;
  let mode: number | undefined;
  try {
    const st = lstatSync(settingsPath);
    mode = st.mode;
    if (st.isSymbolicLink()) {
      targetPath = realpathSync(settingsPath);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.settings.json.tmp.${process.pid}.${randomUUID()}`);

  try {
    writeFileSync(tmpPath, content, "utf-8");
    if (mode !== undefined) {
      chmodSync(tmpPath, mode);
    }
    renameSync(tmpPath, targetPath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best effort: the original write failure is more useful to callers.
    }
    throw error;
  }
}

function readPiEffortSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const value = settings["pi-effort"];
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

export type DisplaySettings = {
  showModelEffortInWorkingMessage: boolean;
  showModelEffortInFooter: boolean;
};

/** Everything the UI sync needs from the `pi-effort` block, read in one pass. */
export type PiEffortSettings = DisplaySettings & {
  fastMode: boolean;
  /** Last choice per model, keyed by `modelKey()`. */
  modelEffort: Record<string, EffortChoice>;
};

function defaultPiEffortSettings(): PiEffortSettings {
  return {
    fastMode: false,
    showModelEffortInWorkingMessage: true,
    showModelEffortInFooter: true,
    modelEffort: {},
  };
}

/** Keep only `model key -> known choice` pairs; anything else in the file is ignored. */
function parseModelEffort(value: unknown): Record<string, EffortChoice> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, EffortChoice> = {};
  for (const [key, choice] of Object.entries(value)) {
    if (typeof choice === "string" && (isEffortLevel(choice) || choice === DEFAULT_TOKEN)) result[key] = choice;
  }
  return result;
}

/** A missing or corrupt settings file yields the defaults: fast off, every display shown, nothing remembered. */
export function getPiEffortSettings(settingsPath: string): PiEffortSettings {
  try {
    const piEffort = readPiEffortSettings(readSettingsObject(settingsPath));
    return {
      fastMode: piEffort.fastMode === true,
      showModelEffortInWorkingMessage: piEffort.showModelEffortInWorkingMessage !== false,
      showModelEffortInFooter: piEffort.showModelEffortInFooter !== false,
      modelEffort: parseModelEffort(piEffort.modelEffort),
    };
  } catch {
    return defaultPiEffortSettings();
  }
}

export function getFastMode(settingsPath: string): boolean {
  return getPiEffortSettings(settingsPath).fastMode;
}

export function getDisplaySettings(settingsPath: string): DisplaySettings {
  const { showModelEffortInWorkingMessage, showModelEffortInFooter } = getPiEffortSettings(settingsPath);
  return { showModelEffortInWorkingMessage, showModelEffortInFooter };
}

/** Read settings.json, let `update` change the `pi-effort` block, write it back if `update` returns true. */
function updatePiEffortSettings(settingsPath: string, update: (piEffort: Record<string, unknown>) => boolean): void {
  const settings = readSettingsObject(settingsPath);
  const piEffort = readPiEffortSettings(settings);
  if (!update(piEffort)) return;
  settings["pi-effort"] = piEffort;
  writeSettingsObject(settingsPath, settings);
}

export function writeFastMode(settingsPath: string, enabled: boolean): void {
  updatePiEffortSettings(settingsPath, (piEffort) => {
    piEffort.fastMode = enabled;
    return true;
  });
}

/** Stable per-model key, `provider/id`. Undefined when no model is active. */
export function modelKey(model: { id?: string; provider?: string } | null | undefined): string | undefined {
  if (!model?.id) return undefined;
  return `${model.provider ?? ""}/${model.id}`;
}

/** Remember `level` for the model. The file is written only when the stored value changes. */
export function writeModelEffort(settingsPath: string, key: string, level: EffortChoice): void {
  updatePiEffortSettings(settingsPath, (piEffort) => {
    const raw = piEffort.modelEffort;
    const modelEffort: Record<string, unknown> =
      raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    if (modelEffort[key] === level) return false;
    modelEffort[key] = level;
    piEffort.modelEffort = modelEffort;
    return true;
  });
}

// ─── Provider default ───────────────────────────────────────────────

/** Top-level request fields through which pi-ai 0.84 sends "thinking off", across its APIs. */
const THINKING_OFF_FIELDS = ["reasoning", "reasoning_effort", "thinking", "enable_thinking"] as const;

/**
 * Remove the fields that tell the provider to skip thinking, so it applies the model's own default.
 * Call it only while Pi runs at `off`: then these fields carry nothing but the "off" request.
 * Returns undefined when the payload has none of them.
 */
export function stripThinkingOff(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const body: Record<string, unknown> = { ...payload };
  let changed = false;
  for (const field of THINKING_OFF_FIELDS) {
    if (field in body) {
      delete body[field];
      changed = true;
    }
  }
  // Chat-template hosts (vLLM, SGLang, Qwen): `chat_template_kwargs.enable_thinking: false`.
  const kwargs = body.chat_template_kwargs;
  if (kwargs && typeof kwargs === "object" && !Array.isArray(kwargs) && "enable_thinking" in kwargs) {
    const { enable_thinking: _off, ...rest } = kwargs as Record<string, unknown>;
    body.chat_template_kwargs = rest;
    changed = true;
  }
  // Google Gemini and Vertex: `config.thinkingConfig` with a zero budget or minimal level.
  const config = body.config;
  if (config && typeof config === "object" && !Array.isArray(config) && "thinkingConfig" in config) {
    const { thinkingConfig: _off, ...rest } = config as Record<string, unknown>;
    body.config = rest;
    changed = true;
  }
  return changed ? body : undefined;
}

// ─── Help text ──────────────────────────────────────────────────────

export const USAGE = "Usage: /effort [min|minimal|low|medium|high|xhigh|max|off|default]";
export const FAST_USAGE = "Usage: /fast [on|off]";
