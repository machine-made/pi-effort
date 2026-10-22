import test from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ThinkingLevel } from "@earendil-works/pi-ai";
import {
  FAST_USAGE,
  USAGE,
  USER_LEVELS,
  getAvailableThinkingLevels,
  getDisplaySettings,
  getFastMode,
  getPiEffortSettings,
  getUserFacingLevels,
  modelKey,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  stripThinkingOff,
  cycleLevel,
  writeFastMode,
  writeModelEffort,
  isFastEligible,
} from "../effort.ts";

// If @earendil-works/pi-ai adds a new ThinkingLevel (e.g. "xmax"), this
// refuses to compile until USER_LEVELS is extended. Removal is already
// caught by `satisfies readonly ThinkingLevel[]` in effort.ts.
type _UncoveredLevels = Exclude<ThinkingLevel, (typeof USER_LEVELS)[number]>;
const _driftCheck: [_UncoveredLevels] extends [never] ? true : never = true;
void _driftCheck;

const standardReasoningModel = { id: "minimax/minimax-m2.7", reasoning: true } as const;
const xhighReasoningModel = { id: "gpt-5.4", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } as const;
const opusXhighReasoningModel = { id: "claude-opus-4.6", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } } as const;
const maxReasoningModel = { id: "deepseek-v4-flash", reasoning: true, thinkingLevelMap: { high: "high", max: "max" } } as const;
const maxOnlyReasoningModel = {
  id: "kimi-k3",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: "max" },
} as const;

// ─── parseEffortCommand / parseFastCommand ──────────────────────────

test("parseEffortCommand handles explicit levels", () => {
  assert.deepEqual(parseEffortCommand("high"), { kind: "set-session", level: "high" });
  assert.deepEqual(parseEffortCommand("xhigh"), { kind: "set-session", level: "xhigh" });
  assert.deepEqual(parseEffortCommand("minimal"), { kind: "set-session", level: "minimal" });
});

test("parseEffortCommand handles min and max aliases", () => {
  assert.deepEqual(parseEffortCommand("min"), { kind: "set-min" });
  assert.deepEqual(parseEffortCommand("max"), { kind: "set-max" });
});

test("parseEffortCommand rejects anything outside the minimal surface", () => {
  assert.throws(() => parseEffortCommand(""), /Usage: \/effort/);
  assert.throws(() => parseEffortCommand("show"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("options"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("default high"), /Usage: \/effort/);
  assert.throws(() => parseEffortCommand("fast on"), /Usage: \/effort/);
});

test("parseEffortCommand maps off to Pi's off state and default to the provider default", () => {
  assert.deepEqual(parseEffortCommand("off"), { kind: "set-session", level: "off" });
  assert.deepEqual(parseEffortCommand(" default "), { kind: "set-default" });
  assert.throws(() => parseEffortCommand("defualt"), /Did you mean "default"\?/);
});

test("resolveEffortCommand resolves aliases per model and passes explicit levels through", () => {
  assert.equal(resolveEffortCommand({ kind: "set-min" }, xhighReasoningModel), "minimal");
  assert.equal(resolveEffortCommand({ kind: "set-max" }, xhighReasoningModel), "xhigh");
  assert.equal(resolveEffortCommand({ kind: "set-max" }, { id: "plain-model", reasoning: false }), undefined);
  assert.equal(resolveEffortCommand({ kind: "set-session", level: "off" }, standardReasoningModel), "off");
  assert.equal(resolveEffortCommand({ kind: "set-default" }, standardReasoningModel), "off");
});

test("parseEffortCommand suggests close matches for effort typos", () => {
  assert.throws(() => parseEffortCommand("hihg"), /Did you mean "high"\?/);
  assert.throws(() => parseEffortCommand("mn"), /Did you mean "min"\?/);
  assert.throws(() => parseEffortCommand("maxe"), /Did you mean "max"\?/);
});

test("parseEffortCommand does not suggest distant typos", () => {
  assert.throws(() => parseEffortCommand("xyz"), /Unknown effort level/);
  let message = "";
  try {
    parseEffortCommand("xyz");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.doesNotMatch(message, /Did you mean/);
});

test("parseFastCommand toggles with no args and handles explicit overrides", () => {
  assert.deepEqual(parseFastCommand(""), { kind: "fast-toggle" });
  assert.deepEqual(parseFastCommand("on"), { kind: "fast-set", enabled: true });
  assert.deepEqual(parseFastCommand("off"), { kind: "fast-set", enabled: false });
  assert.throws(() => parseFastCommand("toggle"), /Unknown fast mode/);
  assert.throws(() => parseFastCommand("status"), /Unknown fast mode/);
});

// ─── resolveMinLevel / resolveMaxLevel ───────────────────────────────

test("resolveMinLevel returns minimal for reasoning models", () => {
  assert.equal(resolveMinLevel(standardReasoningModel), "minimal");
  assert.equal(resolveMinLevel(xhighReasoningModel), "minimal");
});

test("resolveMinLevel returns undefined for non-reasoning models", () => {
  assert.equal(resolveMinLevel({ id: "plain-model", reasoning: false }), undefined);
  assert.equal(resolveMinLevel(null), undefined);
});

test("resolveMinLevel uses the lowest level the model actually supports", () => {
  const noMinimal = {
    id: "no-minimal",
    reasoning: true,
    thinkingLevelMap: { minimal: null },
  } as const;
  assert.equal(resolveMinLevel(noMinimal), "low");
  assert.deepEqual(getUserFacingLevels(noMinimal), ["low", "medium", "high"]);
});

test("resolveMaxLevel returns high for reasoning models without xhigh", () => {
  assert.equal(resolveMaxLevel(standardReasoningModel), "high");
});

test("resolveMaxLevel returns xhigh for xhigh-capable models", () => {
  assert.equal(resolveMaxLevel(xhighReasoningModel), "xhigh");
  assert.equal(resolveMaxLevel(opusXhighReasoningModel), "xhigh");
});

test("resolveMaxLevel returns undefined for non-reasoning models", () => {
  assert.equal(resolveMaxLevel({ id: "plain-model", reasoning: false }), undefined);
  assert.equal(resolveMaxLevel(null), undefined);
});

test("resolveMaxLevel uses the highest level the model actually supports", () => {
  const noHigh = {
    id: "no-high",
    reasoning: true,
    thinkingLevelMap: { high: null, xhigh: null },
  } as const;
  assert.equal(resolveMaxLevel(noHigh), "medium");
  assert.deepEqual(getUserFacingLevels(noHigh), ["minimal", "low", "medium"]);
});

test("resolveMin/Max return undefined when every thinking level is nulled", () => {
  const none = {
    id: "none",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, xhigh: null },
  } as const;
  assert.equal(resolveMinLevel(none), undefined);
  assert.equal(resolveMaxLevel(none), undefined);
});

test("resolveEffortLevel resolves semantic aliases per model", () => {
  const standard = standardReasoningModel;
  const xhigh = xhighReasoningModel;

  assert.equal(resolveEffortLevel("min", standard), "minimal");
  assert.equal(resolveEffortLevel("max", standard), "high");
  assert.equal(resolveEffortLevel("max", xhigh), "xhigh");
  assert.equal(resolveEffortLevel("medium", standard), "medium");
  assert.equal(resolveEffortLevel("min", { id: "plain-model", reasoning: false }), undefined);
});

// ─── max capability (tests ported from PR #7) ────────────────────────

test("max capability: a max-capable model lists max after high", () => {
  assert.deepEqual(getAvailableThinkingLevels(maxReasoningModel), ["off", "minimal", "low", "medium", "high", "max"]);
  assert.deepEqual(getUserFacingLevels(maxReasoningModel), ["minimal", "low", "medium", "high", "max"]);
  assert.equal(resolveMaxLevel(maxReasoningModel), "max");
  assert.equal(resolveEffortLevel("max", maxReasoningModel), "max");
});

test("max capability: a max-only model surfaces only off and max", () => {
  assert.deepEqual(getAvailableThinkingLevels(maxOnlyReasoningModel), ["off", "max"]);
  assert.deepEqual(getUserFacingLevels(maxOnlyReasoningModel), ["max"]);
  assert.equal(resolveMinLevel(maxOnlyReasoningModel), "max");
  assert.equal(resolveMaxLevel(maxOnlyReasoningModel), "max");
});

test("cycleLevel advances through max and wraps on max-capable models", () => {
  assert.equal(cycleLevel("high", maxReasoningModel), "max");
  assert.equal(cycleLevel("max", maxReasoningModel), "minimal");
  assert.equal(cycleLevel("max", maxOnlyReasoningModel), "max");
});

// ─── xhigh capability (via public functions) ─────────────────────────

test("Pi 0.84 max thinking level is last when the model maps it", () => {
  const maxModel = {
    id: "max-model",
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  } as const;
  assert.equal(resolveMaxLevel(maxModel), "max");
  assert.ok(getUserFacingLevels(maxModel).includes("max"));
});

test("xhigh capability: gpt-5.4 includes xhigh in available levels", () => {
  assert.deepEqual(getAvailableThinkingLevels(xhighReasoningModel), [
    "off", "minimal", "low", "medium", "high", "xhigh",
  ]);
});

test("xhigh capability: opus-4.6 includes xhigh in available levels", () => {
  assert.deepEqual(getAvailableThinkingLevels(opusXhighReasoningModel), [
    "off", "minimal", "low", "medium", "high", "xhigh",
  ]);
});

test("xhigh capability: minimax does not include xhigh in available levels", () => {
  assert.deepEqual(getAvailableThinkingLevels(standardReasoningModel), [
    "off", "minimal", "low", "medium", "high",
  ]);
});

// ─── getAvailableThinkingLevels / getUserFacingLevels ────────────────

test("getAvailableThinkingLevels includes off for all reasoning models", () => {
  assert.deepEqual(getAvailableThinkingLevels({ id: "plain-model", reasoning: false }), ["off"]);
  assert.deepEqual(getAvailableThinkingLevels(standardReasoningModel), [
    "off", "minimal", "low", "medium", "high",
  ]);
  assert.deepEqual(getAvailableThinkingLevels(xhighReasoningModel), [
    "off", "minimal", "low", "medium", "high", "xhigh",
  ]);
});

test("getUserFacingLevels excludes off", () => {
  assert.deepEqual(getUserFacingLevels({ id: "plain-model", reasoning: false }), []);
  assert.deepEqual(getUserFacingLevels(standardReasoningModel), [
    "minimal", "low", "medium", "high",
  ]);
  assert.deepEqual(getUserFacingLevels(xhighReasoningModel), [
    "minimal", "low", "medium", "high", "xhigh",
  ]);
});

// ─── cycleLevel ──────────────────────────────────────────────────────

test("cycleLevel advances through user-facing levels", () => {
  const model = xhighReasoningModel;
  assert.equal(cycleLevel("minimal", model), "low");
  assert.equal(cycleLevel("medium", model), "high");
  assert.equal(cycleLevel("xhigh", model), "minimal"); // wraps
});

test("cycleLevel returns first level for unknown current", () => {
  const model = xhighReasoningModel;
  assert.equal(cycleLevel("off", model), "minimal");
  assert.equal(cycleLevel("unknown", model), "minimal");
});

test("cycleLevel returns undefined for non-reasoning models", () => {
  assert.equal(cycleLevel("high", { id: "plain-model", reasoning: false }), undefined);
});

// ─── Settings persistence ────────────────────────────────────────────

test("writeFastMode preserves unrelated settings and writes pi-effort namespace", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "openai-codex" }, null, 2));

  writeFastMode(settingsPath, true);

  const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  assert.equal(parsed.defaultProvider, "openai-codex");
  assert.equal(parsed["pi-effort"].fastMode, true);
  assert.equal(getFastMode(settingsPath), true);

  writeFastMode(settingsPath, false);
  assert.equal(getFastMode(settingsPath), false);
});

// ─── Provider default (issue #8) ─────────────────────────────────────

test("stripThinkingOff removes each API's thinking-off field and keeps the rest", () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ model: "gpt-5.4", input: [], reasoning: { effort: "none" } }, { model: "gpt-5.4", input: [] }],
    [{ model: "m", reasoning_effort: "none" }, { model: "m" }],
    [{ model: "claude", thinking: { type: "disabled" }, max_tokens: 10 }, { model: "claude", max_tokens: 10 }],
    [{ model: "qwen", enable_thinking: false }, { model: "qwen" }],
    [
      { model: "vllm", chat_template_kwargs: { enable_thinking: false, preserve_thinking: true } },
      { model: "vllm", chat_template_kwargs: { preserve_thinking: true } },
    ],
    [
      { model: "gemini-2.5-pro", config: { thinkingConfig: { thinkingBudget: 0 }, temperature: 0 } },
      { model: "gemini-2.5-pro", config: { temperature: 0 } },
    ],
  ];
  for (const [payload, expected] of cases) {
    const before = structuredClone(payload);
    assert.deepEqual(stripThinkingOff(payload), expected);
    assert.deepEqual(payload, before, "input payload must not change");
  }
});

test("stripThinkingOff returns undefined when there is nothing to strip", () => {
  assert.equal(stripThinkingOff({ model: "m", input: [] }), undefined);
  assert.equal(stripThinkingOff({ config: { temperature: 0 } }), undefined);
});

// ─── Per-model effort memory ─────────────────────────────────────────

test("modelKey joins provider and id, and is undefined without a model id", () => {
  assert.equal(modelKey({ id: "gpt-5.4", provider: "openai" }), "openai/gpt-5.4");
  assert.equal(modelKey({ id: "local" }), "/local");
  assert.equal(modelKey(null), undefined);
  assert.equal(modelKey({ provider: "openai" }), undefined);
});

test("writeModelEffort keeps unrelated settings and fast mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "openai", "pi-effort": { fastMode: true } }));

  writeModelEffort(settingsPath, "openai/gpt-5.4", "xhigh");
  writeModelEffort(settingsPath, "anthropic/claude-opus-4.6", "medium");

  const parsed = JSON.parse(readFileSync(settingsPath, "utf-8"));
  assert.equal(parsed.defaultProvider, "openai");
  assert.equal(parsed["pi-effort"].fastMode, true);
  assert.deepEqual(getPiEffortSettings(settingsPath).modelEffort, {
    "openai/gpt-5.4": "xhigh",
    "anthropic/claude-opus-4.6": "medium",
  });
});

test("writeModelEffort leaves the file untouched when the level is already stored", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeModelEffort(settingsPath, "openai/gpt-5.4", "high");
  const before = statSync(settingsPath).ino;

  writeModelEffort(settingsPath, "openai/gpt-5.4", "high");
  assert.equal(statSync(settingsPath).ino, before);

  writeModelEffort(settingsPath, "openai/gpt-5.4", "low");
  assert.notEqual(statSync(settingsPath).ino, before);
});

test("getPiEffortSettings ignores malformed modelEffort entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ "pi-effort": { modelEffort: { "a/x": "high", "a/y": "turbo", "a/z": 3 } } })
  );
  assert.deepEqual(getPiEffortSettings(settingsPath).modelEffort, { "a/x": "high" });

  writeFileSync(settingsPath, JSON.stringify({ "pi-effort": { modelEffort: ["high"] } }));
  assert.deepEqual(getPiEffortSettings(settingsPath).modelEffort, {});

  writeFileSync(settingsPath, "{not json}");
  assert.deepEqual(getPiEffortSettings(settingsPath).modelEffort, {});
});

test("isFastEligible requires an OpenAI-family provider and a gpt-5 model id", () => {
  assert.equal(isFastEligible({ id: "gpt-5.4", provider: "openai" }), true);
  assert.equal(isFastEligible({ id: "gpt-5.4", provider: "openai-codex" }), true);
  assert.equal(isFastEligible({ id: "gpt-5.4", provider: "openrouter" }), false);
  assert.equal(isFastEligible({ id: "claude-opus-4.6", provider: "openai" }), false);
  assert.equal(isFastEligible({ id: "gpt-5.4" }), false);
});

test("writeFastMode keeps a settings.json symlink and writes through it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const realPath = join(dir, "real-settings.json");
  const linkPath = join(dir, "settings.json");
  writeFileSync(realPath, "{}\n");
  symlinkSync(realPath, linkPath);
  writeFastMode(linkPath, true);
  assert.equal(lstatSync(linkPath).isSymbolicLink(), true);
  assert.equal(JSON.parse(readFileSync(realPath, "utf-8"))["pi-effort"].fastMode, true);
});

test("getFastMode returns false when unset or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ otherKey: "value" }, null, 2));
  assert.equal(getFastMode(settingsPath), false);

  writeFileSync(settingsPath, "{not json}");
  assert.equal(getFastMode(settingsPath), false);
});

test("getDisplaySettings shows everything when unset or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  const showEverything = { showModelEffortInWorkingMessage: true, showModelEffortInFooter: true };
  assert.deepEqual(getDisplaySettings(settingsPath), showEverything);

  writeFileSync(settingsPath, "{not json}");
  assert.deepEqual(getDisplaySettings(settingsPath), showEverything);
});

test("getDisplaySettings hides only on an explicit false", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(
    settingsPath,
    JSON.stringify({ "pi-effort": { showModelEffortInWorkingMessage: false, showModelEffortInFooter: "no" } })
  );
  assert.deepEqual(getDisplaySettings(settingsPath), {
    showModelEffortInWorkingMessage: false,
    showModelEffortInFooter: true,
  });
});

// ─── USAGE ───────────────────────────────────────────────────────────

test("USAGE exposes only effort and fast primitives", () => {
  assert.match(USAGE, /min/);
  assert.match(USAGE, /max/);
  assert.match(USAGE, /\/effort/);
  assert.match(USAGE, /\|off\|default\]/);
  assert.doesNotMatch(USAGE, /options|show|fast/);
  assert.equal(FAST_USAGE, "Usage: /fast [on|off]");
});

// ─── Completion filtering (via getUserFacingLevels) ──────────────────

test("completion filter: non-reasoning model — no thinking levels", () => {
  const model = { id: "some-gpt-3.5", reasoning: false };
  const levels = getUserFacingLevels(model);
  assert.deepEqual(levels, []);
});

test("completion filter: reasoning model without xhigh — includes high but not xhigh", () => {
  const model = standardReasoningModel;
  const levels = getUserFacingLevels(model);
  assert.ok(levels.includes("high"), "should include high");
  assert.equal(levels.includes("xhigh" as any), false, "should not include xhigh");
});

test("completion filter: xhigh-capable model — includes xhigh", () => {
  const model = xhighReasoningModel;
  const levels = getUserFacingLevels(model);
  assert.ok(levels.includes("xhigh" as any), "should include xhigh");
});
