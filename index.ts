import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import {
  SEMANTIC_ALIASES,
  USER_LEVELS,
  type EffortLevel,
  type EffortModel,
  cycleLevel,
  getAvailableThinkingLevels,
  getFastMode,
  getUserFacingLevels,
  isEffortAlias,
  parseEffortCommand,
  parseFastCommand,
  resolveEffortLevel,
  resolveMaxLevel,
  resolveMinLevel,
  toThinkingLevel,
  writeFastMode,
} from "./effort.js";

function modelName(model: EffortModel | null | undefined): string {
  return model?.id ?? "current model";
}

function formatAvailableLevels(model: EffortModel | null | undefined): string {
  return getAvailableThinkingLevels(model).join(", ");
}

function isFastModelId(modelId: string): boolean {
  return modelId.startsWith("gpt-5");
}

function isFastModeApplicable(model: EffortModel | null | undefined): boolean {
  return typeof model?.id === "string" && isFastModelId(model.id);
}

function requestEffortRender(ctx: ExtensionContext): void {
  // Clear older pi-effort aggregate status lines. Dedicated powerline custom
  // items read pi-effort-thinking / pi-effort-fast instead.
  ctx.ui.setStatus("effort", undefined);
}

function updateEffortUi(ctx: ExtensionContext, current: string, fastMode: boolean, updateWorkingMessage = true): void {
  requestEffortRender(ctx);
  ctx.ui.setStatus("pi-effort-thinking", `think:${current}`);
  ctx.ui.setStatus("pi-effort-fast", fastMode && isFastModeApplicable(ctx.model) ? "fast" : undefined);
  if (updateWorkingMessage) {
    ctx.ui.setWorkingMessage(current === "off" ? undefined : `Working (${current} effort)...`);
  }
}

function applySessionLevel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  level: EffortLevel,
  fastMode: boolean
): void {
  const available = getAvailableThinkingLevels(ctx.model);
  if (!available.includes(level)) {
    ctx.ui.notify(
      `Model ${modelName(ctx.model)} does not support ${level}. Available: ${formatAvailableLevels(ctx.model)}`,
      "error"
    );
    return;
  }

  const before = pi.getThinkingLevel();
  pi.setThinkingLevel(toThinkingLevel(level));
  const after = pi.getThinkingLevel();
  const appliesNow = ctx.isIdle();
  updateEffortUi(ctx, after, fastMode, appliesNow);
  const suffix = appliesNow ? "" : " (applies next prompt)";
  ctx.ui.notify(before === after ? `Effort already ${after}` : `Effort changed: ${before} -> ${after}${suffix}`, "info");
}

export default function effortExtension(pi: ExtensionAPI): void {
  const settingsPath = join(getAgentDir(), "settings.json");

  // ─── Closure: track current model for tab completion ─────────────
  let currentModel: EffortModel | null = null;
  let activeRunEffort: string | undefined;
  let fastMode = getFastMode(settingsPath);

  function refreshFastMode(): boolean {
    fastMode = getFastMode(settingsPath);
    return fastMode;
  }

  function syncEffortUi(ctx: ExtensionContext, current: string = pi.getThinkingLevel()): string {
    updateEffortUi(ctx, current, refreshFastMode());
    return current;
  }

  // ─── CLI flag ────────────────────────────────────────────────────
  pi.registerFlag("effort", {
    description: "Initial thinking effort level (min|max|minimal|low|medium|high|xhigh)",
    type: "string",
  });

  // ─── Provider hook: fast mode maps to OpenAI/Codex priority tier ──
  pi.on("before_provider_request", (event) => {
    if (!fastMode) return undefined;

    const payload = event.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }

    const body = payload as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (!isFastModelId(model) || body.service_tier !== undefined) {
      return undefined;
    }

    return {
      ...body,
      service_tier: "priority",
    };
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
      pi.setThinkingLevel(toThinkingLevel(next));
      const after = pi.getThinkingLevel();
      const appliesNow = ctx.isIdle();
      updateEffortUi(ctx, after, refreshFastMode(), appliesNow);
      const suffix = appliesNow ? "" : " (applies next prompt)";
      ctx.ui.notify(`Effort: ${current} -> ${after}${suffix}`, "info");
    },
  });

  // ─── session_start: sync visible effort UI + apply --effort flag ─
  pi.on("session_start", (_event, ctx) => {
    // Track model for tab completion
    currentModel = ctx.model ?? null;
    // Sync current effort labels
    syncEffortUi(ctx);

    // Apply --effort CLI flag if present
    const flagValue = pi.getFlag("effort");
    if (typeof flagValue === "string" && flagValue) {
      const requested = flagValue.trim();
      const isKnownRequest = USER_LEVELS.includes(requested as any) || isEffortAlias(requested);
      if (!isKnownRequest) {
        ctx.ui.notify(`--effort ${flagValue}: unknown effort level`, "warning");
        return;
      }

      const resolved = resolveEffortLevel(requested as EffortLevel | "min" | "max", ctx.model);
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
      syncEffortUi(ctx);
    }
  });

  // ─── model_select: sync visible effort UI ────────────────────────
  pi.on("model_select", (event, ctx) => {
    currentModel = event.model;
    const visibleEffort = ctx.isIdle() ? pi.getThinkingLevel() : activeRunEffort ?? pi.getThinkingLevel();
    syncEffortUi(ctx, visibleEffort);
  });

  // Keep labels fresh if the user changes thinking through Pi's native UI.
  // During an active run, keep the loader tied to the run-start effort so a
  // mid-stream change is not misrepresented as affecting in-flight requests.
  pi.on("agent_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort = pi.getThinkingLevel();
    syncEffortUi(ctx, activeRunEffort);
  });

  pi.on("turn_start", (_event, ctx) => {
    currentModel = ctx.model ?? currentModel;
    activeRunEffort ??= pi.getThinkingLevel();
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
    ctx.ui.notify(`Fast mode ${fastMode ? "enabled" : "disabled"}.`, "info");
  }

  // ─── /effort command ─────────────────────────────────────────────
  pi.registerCommand("effort", {
    description: "Set thinking effort (min/max adapt per model)",
    getArgumentCompletions: (prefix) => {
      const value = prefix.trimStart();
      const tokens = value.split(/\s+/).filter(Boolean);
      const trailingSpace = /\s$/.test(value);

      const modelLevels = getUserFacingLevels(currentModel);
      // Dedup: "max" may already be in modelLevels for max-capable models.
      const options = modelLevels.length > 0 ? [...new Set(["min", ...modelLevels, "max"])] : [];

      if (tokens.length === 0) {
        return options.map((t) => ({ value: t, label: t }));
      }

      if (tokens.length === 1 && !trailingSpace) {
        return options
          .filter((t) => t.startsWith(tokens[0]))
          .map((t) => ({ value: t, label: t }));
      }

      return null;
    },
    handler: async (args, ctx) => {
      let command;
      try {
        command = parseEffortCommand(args);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(message, "error");
        return;
      }

      switch (command.kind) {
        case "set-session":
          applySessionLevel(pi, ctx, command.level, refreshFastMode());
          return;

        case "set-min": {
          const resolved = resolveMinLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode());
          return;
        }

        case "set-max": {
          const resolved = resolveMaxLevel(ctx.model);
          if (!resolved) {
            ctx.ui.notify(`Thinking not available for ${modelName(ctx.model)}`, "error");
            return;
          }
          applySessionLevel(pi, ctx, resolved, refreshFastMode());
          return;
        }
      }
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
