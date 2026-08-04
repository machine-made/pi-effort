import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ThinkingLevel } from "@mariozechner/pi-ai";
import {
  FAST_USAGE,
  USAGE,
  type USER_LEVELS,
  getAvailableThinkingLevels,
  getFastMode,
  getUserFacingLevels,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  cycleLevel,
  writeFastMode,
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
const maxOnlyReasoningModel = { id: "kimi-k3", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: "max" } } as const;

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
  assert.throws(() => parseEffortCommand("off"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("show"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("options"), /Unknown effort level/);
  assert.throws(() => parseEffortCommand("default high"), /Usage: \/effort/);
  assert.throws(() => parseEffortCommand("fast on"), /Usage: \/effort/);
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

test("resolveMaxLevel returns high for reasoning models without xhigh", () => {
  assert.equal(resolveMaxLevel(standardReasoningModel), "high");
});

test("resolveMaxLevel returns xhigh for xhigh-capable models", () => {
  assert.equal(resolveMaxLevel(xhighReasoningModel), "xhigh");
  assert.equal(resolveMaxLevel(opusXhighReasoningModel), "xhigh");
});

test("resolveMaxLevel returns max for max-capable models", () => {
  assert.equal(resolveMaxLevel(maxReasoningModel), "max");
  assert.equal(resolveMaxLevel(maxOnlyReasoningModel), "max");
});

test("resolveMaxLevel returns undefined for non-reasoning models", () => {
  assert.equal(resolveMaxLevel({ id: "plain-model", reasoning: false }), undefined);
  assert.equal(resolveMaxLevel(null), undefined);
});

test("resolveEffortLevel resolves semantic aliases per model", () => {
  const standard = standardReasoningModel;
  const xhigh = xhighReasoningModel;

  assert.equal(resolveEffortLevel("min", standard), "minimal");
  assert.equal(resolveEffortLevel("max", standard), "high");
  assert.equal(resolveEffortLevel("max", xhigh), "xhigh");
  assert.equal(resolveEffortLevel("max", maxReasoningModel), "max");
  assert.equal(resolveEffortLevel("max", maxOnlyReasoningModel), "max");
  assert.equal(resolveEffortLevel("medium", standard), "medium");
  assert.equal(resolveEffortLevel("min", { id: "plain-model", reasoning: false }), undefined);
});

// ─── xhigh capability (via public functions) ─────────────────────────

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

test("max capability: deepseek includes max in available levels", () => {
  assert.deepEqual(getAvailableThinkingLevels(maxReasoningModel), [
    "off", "minimal", "low", "medium", "high", "max",
  ]);
});

test("max capability: max-only model surfaces only off and max", () => {
  assert.deepEqual(getAvailableThinkingLevels(maxOnlyReasoningModel), [
    "off", "max",
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
  assert.deepEqual(getUserFacingLevels(maxReasoningModel), [
    "minimal", "low", "medium", "high", "max",
  ]);
  assert.deepEqual(getUserFacingLevels(maxOnlyReasoningModel), ["max"]);
});

// ─── cycleLevel ──────────────────────────────────────────────────────

test("cycleLevel advances through user-facing levels", () => {
  const model = xhighReasoningModel;
  assert.equal(cycleLevel("minimal", model), "low");
  assert.equal(cycleLevel("medium", model), "high");
  assert.equal(cycleLevel("xhigh", model), "minimal"); // wraps
});

test("cycleLevel advances through max on max-capable models", () => {
  const model = maxReasoningModel;
  assert.equal(cycleLevel("high", model), "max");
  assert.equal(cycleLevel("max", model), "minimal"); // wraps
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

test("getFastMode returns false when unset or corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-effort-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ otherKey: "value" }, null, 2));
  assert.equal(getFastMode(settingsPath), false);

  writeFileSync(settingsPath, "{not json}");
  assert.equal(getFastMode(settingsPath), false);
});

// ─── USAGE ───────────────────────────────────────────────────────────

test("USAGE exposes only effort and fast primitives", () => {
  assert.match(USAGE, /min/);
  assert.match(USAGE, /max/);
  assert.match(USAGE, /\/effort/);
  assert.doesNotMatch(USAGE, /default|options|show|fast/);
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
