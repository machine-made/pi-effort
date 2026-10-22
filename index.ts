import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_TOKEN,
  type DisplaySettings,
  type EffortChoice,
  type EffortLevel,
  type EffortModel,
  cycleLevel,
  getAvailableThinkingLevels,
  FAST_ON_NOTICE,
  getFastMode,
  getPiEffortSettings,
  getUserFacingLevels,
  isFastEligible,
  modelKey,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortCommand,
  stripThinkingOff,
  toThinkingLevel,
  writeFastMode,
  writeModelEffort,
} from "./effort.js";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

/** `/effort` tokens for the model: `min`, its reasoning levels, `max`, then `off` and `default`. */
function effortOptions(model: EffortModel | null | undefined): string[] {
  const levels = getUserFacingLevels(model);
  if (levels.length === 0) return [];
  // `max` is always offered last as the alias; a max-only model still gets `min` and `max`.
  const options = ["min", ...levels.filter((level) => level !== "max"), "max"];
  // Some models cannot turn thinking off (`thinkingLevelMap.off: null`, e.g. gpt-5).
  // `default` also needs `off`: it runs Pi at off and removes the off fields from each request.
  return getAvailableThinkingLevels(model).includes("off") ? [...options, "off", DEFAULT_TOKEN] : options;
}

/** Completion and picker labels for the two tokens whose name alone is unclear. */
const OPTION_LABELS: Record<string, string> = {
  off: "off (no thinking)",
  [DEFAULT_TOKEN]: "default (model's own effort)",
};

function optionLabel(token: string): string {
  return OPTION_LABELS[token] ?? token;
}

function isFastModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-5");
}

function updateEffortUi(
  ctx: ExtensionContext,
  current: string,
  fastMode: boolean,
  display: DisplaySettings,
  updateWorkingMessage = true
): void {
  const showFooter = display.showModelEffortInFooter;
  ctx.ui.setStatus("pi-effort-thinking", showFooter ? `think:${current}` : undefined);
  ctx.ui.setStatus("pi-effort-fast", showFooter && fastMode && isFastEligible(ctx.model) ? "fast" : undefined);
  if (updateWorkingMessage && display.showModelEffortInWorkingMessage) {
    ctx.ui.setWorkingMessage(current === "off" ? undefined : `Working (${current} effort)...`);
  }
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");

  // ─── Closure: track current model for tab completion ─────────────
  let currentModel: EffortModel | null = null;
  let activeRunEffort: string | undefined;
  let fastMode = getFastMode(settingsPath);
  // Tracks whether this extension owns the working message, so turning the display off clears it once.
  let ownsWorkingMessage = false;
  // `/effort default`: Pi runs at off and before_provider_request strips the off fields.
  let providerDefault = false;

  /** The user's current choice: Pi's level, or `default` while provider-default mode is on. */
  function currentChoice(): EffortChoice {
    const level = pi.getThinkingLevel() as EffortLevel;
    return providerDefault && level === "off" ? DEFAULT_TOKEN : level;
  }

  function refreshFastMode(): boolean {
    fastMode = getFastMode(settingsPath);
    return fastMode;
  }

  function syncEffortUi(
    ctx: ExtensionContext,
    current: string = currentChoice(),
    updateWorkingMessage = true
  ): string {
    const settings = getPiEffortSettings(settingsPath);
    fastMode = settings.fastMode;
    if (ownsWorkingMessage && !settings.showModelEffortInWorkingMessage) {
      ctx.ui.setWorkingMessage(undefined);
      ownsWorkingMessage = false;
    }
    updateEffortUi(ctx, current, fastMode, settings, updateWorkingMessage);
    if (updateWorkingMessage && settings.showModelEffortInWorkingMessage) {
      ownsWorkingMessage = true;
    }
    return current;
  }

  /** The effort the loader should show: during a run it stays tied to the run-start effort. */
  function visibleEffort(ctx: ExtensionContext): string {
    return ctx.isIdle() ? currentChoice() : activeRunEffort ?? currentChoice();
  }

  /** Remember the current level for the active model. A failed write never blocks the effort change. */
  function rememberEffort(ctx: ExtensionContext): void {
    const key = modelKey(ctx.model);
    if (!key) return;
    try {
      writeModelEffort(settingsPath, key, currentChoice());
    } catch (error) {
      ctx.ui.notify(`Failed to remember effort: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  /** Set `level` (with `useDefault`, the provider-default mode), remember it, refresh the UI, report. */
  function applySessionLevel(ctx: ExtensionContext, level: EffortLevel, useDefault = false): void {
    const available = getAvailableThinkingLevels(ctx.model);
    if (!available.includes(level)) {
      ctx.ui.notify(
        `Model ${modelName(ctx.model)} does not support ${level}. Available: ${formatAvailableLevels(ctx.model)}`,
        "error"
      );
      return;
    }

    const before = currentChoice();
    pi.setThinkingLevel(toThinkingLevel(level));
    providerDefault = useDefault && pi.getThinkingLevel() === "off";
    const after = currentChoice();
    // Pi fires thinking_level_select only on a change, so record here too.
    rememberEffort(ctx);
    const appliesNow = ctx.isIdle();
    syncEffortUi(ctx, after, appliesNow);
    const suffix = appliesNow ? "" : " (applies next prompt)";
    ctx.ui.notify(before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
  }

  // ─── CLI flag ────────────────────────────────────────────────────
  pi.registerFlag("effort", {
    description: "Initial thinking effort level (min|minimal|low|medium|high|xhigh|max|off|default)",
    type: "string",
  });

  // ─── Provider hook: fast mode maps to OpenAI/Codex priority tier ──
  pi.on("before_provider_request", (event, ctx) => {
    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const body = payload as Record<string, unknown>;
    let next = body;
    if (providerDefault && pi.getThinkingLevel() === "off") {
      next = stripThinkingOff(next) ?? next;
    }

    const model = typeof body.model === "string" ? body.model : "";
    if (fastMode && isFastEligible(ctx.model) && isFastModelId(model) && body.service_tier === undefined) {
      next = { ...next, service_tier: "priority" };
    }

    return next === body ? undefined : next;
  });

  // ─── Keyboard shortcut: Ctrl+Shift+E to cycle effort ─────────────
  pi.registerShortcut("ctrl+shift+e", {
    description: "Cycle effort level",
    handler: (ctx) => {
      const current = pi.getThinkingLevel();
      const next = cycleLevel(current, ctx.model);
      if (!next) {
        ctx.ui.notify("Thinking not available for this model", "warning");
        return;
      }
      applySessionLevel(ctx, next);
    },
  });

  // ─── session_start: sync visible effort UI + apply --effort flag ─
  pi.on("session_start", (_event, ctx) => {
    // Track model for tab completion
    currentModel = ctx.model ?? null;
    // Pi saves `off` for a `default` choice; the model's remembered choice tells the two apart.
    const startKey = modelKey(ctx.model);
    providerDefault =
      pi.getThinkingLevel() === "off" &&
      startKey !== undefined &&
      getPiEffortSettings(settingsPath).modelEffort[startKey] === DEFAULT_TOKEN;
    // Sync current effort labels
    syncEffortUi(ctx);
    if (fastMode) {
      ctx.ui.notify(FAST_ON_NOTICE, "warning");
    }

    // Apply --effort CLI flag if present
    const flagValue = pi.getFlag("effort");
    if (typeof flagValue === "string" && flagValue) {
      let command;
      try {
        command = parseEffortCommand(flagValue);
      } catch {
        ctx.ui.notify(`--effort ${flagValue}: unknown effort level`, "warning");
        return;
      }

      const resolved = resolveEffortCommand(command, ctx.model);
      if (!resolved) {
        ctx.ui.notify(`--effort ${flagValue}: thinking not available for ${modelName(ctx.model)}`, "warning");
        return;
      }

      const available = getAvailableThinkingLevels(ctx.model);
      if (!available.includes(resolved)) {
        ctx.ui.notify(
          `--effort ${flagValue}: not supported by ${modelName(ctx.model)}. Available: ${formatAvailableLevels(ctx.model)}`,
          "warning"
        );
        return;
      }

      pi.setThinkingLevel(toThinkingLevel(resolved));
      providerDefault = command.kind === "set-default" && pi.getThinkingLevel() === "off";
      syncEffortUi(ctx);
    }
  });

  // ─── model_select: restore the model's remembered effort, sync UI ─
  // Pi has already clamped the previous level to the new model. A level the user chose for this
  // model earlier wins over that clamp, except over a scoped pin such as `enabledModels: ["x:high"]`.
  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    const key = modelKey(event.model);
    const remembered = key ? getPiEffortSettings(settingsPath).modelEffort[key] : undefined;
    const target = remembered === DEFAULT_TOKEN ? "off" : remembered;
    const pinned =
      event.source === "cycle" &&
      ctx.scopedModels.some((scoped) => modelKey(scoped.model) === key && scoped.thinkingLevel !== undefined);
    if (
      event.source !== "restore" &&
      remembered !== undefined &&
      target !== undefined &&
      !pinned &&
      remembered !== currentChoice() &&
      getAvailableThinkingLevels(event.model).includes(target)
    ) {
      pi.setThinkingLevel(toThinkingLevel(target));
      providerDefault = remembered === DEFAULT_TOKEN;
      ctx.ui.notify(`Effort ${remembered} restored for ${modelName(event.model)}`, "info");
    } else if (pi.getThinkingLevel() !== "off") {
      providerDefault = false;
    }
    syncEffortUi(ctx, visibleEffort(ctx));
  });

  // ─── thinking_level_select: remember changes made in Pi's own UI ──
  // During a model switch Pi sets the new model, clamps the level (firing this event), and only then
  // fires model_select. Until then currentModel is still the old model, so the clamp is not recorded.
  pi.on("thinking_level_select", (event, ctx) => {
    // Any real level ends provider-default mode; `off` from Pi's selector keeps it.
    if (event.level !== "off") providerDefault = false;
    if (modelKey(ctx.model) === modelKey(currentModel)) rememberEffort(ctx);
    syncEffortUi(ctx, visibleEffort(ctx));
  });

  // Keep labels fresh if the user changes thinking through Pi's native UI.
  // During an active run, keep the loader tied to the run-start effort so a
  // mid-stream change is not misrepresented as affecting in-flight requests.
  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort = currentChoice();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort ??= currentChoice();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("agent_end", (_event, ctx) => {
    activeRunEffort = undefined;
    syncEffortUi(ctx);
  });

  function setFastMode(ctx: ExtensionContext, enabled: boolean): void {
    try {
      writeFastMode(settingsPath, enabled);
    } catch (error) {
      ctx.ui.notify(`Failed to update fast mode: ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    fastMode = enabled;
    syncEffortUi(ctx);
    ctx.ui.notify(fastMode ? FAST_ON_NOTICE : "Fast mode disabled.", fastMode ? "warning" : "info");
  }

  // ─── /effort command ─────────────────────────────────────────────
  pi.registerCommand("effort", {
    description: "Set thinking effort (min/max adapt per model)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);

      const options = effortOptions(currentModel);

      if (tokens.length === 0) {
        return options.map((t) => ({ value: t, label: optionLabel(t) }));
      }

      if (tokens.length === 1 && !trailingSpace) {
        return options
          .filter((t) => t.startsWith(tokens[0]))
          .map((t) => ({ value: t, label: optionLabel(t) }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let input = args.trim();
      // Without a UI, select() resolves to undefined; fall through to the usage error instead.
      if (input === "" && ctx.hasUI) {
        const options = effortOptions(ctx.model);
        if (options.length === 0) {
          ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
          return;
        }
        const labels = options.map(optionLabel);
        const picked = await ctx.ui.select(`Effort (current: ${currentChoice()})`, labels);
        if (!picked) return;
        input = options[labels.indexOf(picked)] ?? picked;
      }

      let command;
      try {
        command = parseEffortCommand(input);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const resolved = resolveEffortCommand(command, ctx.model);
      if (!resolved) {
        ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
        return;
      }
      applySessionLevel(ctx, resolved, command.kind === "set-default");
    },
  });

  pi.registerCommand("fast", {
    description: "Set fast mode",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);
      const firstPrefix = trailingSpace ? "" : tokens[0] ?? "";
      const options = ["on", "off"];

      if (tokens.length === 0 || (tokens.length === 1 && !trailingSpace)) {
        return options
          .filter((t) => t.startsWith(firstPrefix))
          .map((t) => ({ value: t, label: t }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseFastCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      const enabled = command.kind === "fast-toggle" ? !refreshFastMode() : command.enabled;
      setFastMode(ctx, enabled);
    },
  });
}
