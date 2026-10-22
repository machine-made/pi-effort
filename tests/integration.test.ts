import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createEventBus,
  SessionManager,
  SettingsManager,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { USAGE } from "../effort.ts";
import effortExtension from "../index.ts";

type PiThinkingLevel = ThinkingLevel | "off";

const reasoningModel: Model<any> = {
  id: "minimax/minimax-m2.7",
  name: "MiniMax M2.7",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const xhighModel: Model<any> = {
  id: "gpt-5.4",
  name: "GPT-5.4",
  api: "openai-completions",
  provider: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { xhigh: "xhigh" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const maxModel: Model<any> = {
  id: "deepseek-v4-flash",
  name: "DeepSeek V4 Flash",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { high: "high", max: "max" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const maxOnlyModel: Model<any> = {
  id: "kimi-k3",
  name: "Kimi K3",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: null, medium: null, high: null, max: "max" },
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 196608,
  maxTokens: 4096,
};

const plainModel: Model<any> = {
  id: "plain-model",
  name: "Plain Model",
  api: "openai-completions",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
};

function createResourceLoader(extensionsResult: LoadExtensionsResult): ResourceLoader {
  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => undefined,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function writePiEffortSettings(agentDir: string, piEffortSettings: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ "pi-effort": piEffortSettings }));
}

function makeSessionConfig(piEffortSettings?: Record<string, unknown>) {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-effort-runtime-"));
  const agentDir = join(tempRoot, "agent");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // Model switches check auth; a placeholder key keeps the suite independent of the environment.
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openrouter: { type: "api_key", key: "test-key" } }));
  if (piEffortSettings) {
    writePiEffortSettings(agentDir, piEffortSettings);
  }

  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const runtime = createExtensionRuntime();
  const eventBus = createEventBus();
  const extensionPromise = loadExtensionFromFactory(effortExtension, cwd, eventBus, runtime, "<pi-effort-test>");

  return {
    tempRoot,
    agentDir,
    cwd,
    previousAgentDir,
    extensionPromise,
    runtime,
    eventBus,
  };
}

interface RecordingUI {
  uiContext: ExtensionUIContext;
  statuses: Map<string, string | undefined>;
  workingMessages: (string | undefined)[];
}

function createRecordingUI(): RecordingUI {
  const statuses = new Map<string, string | undefined>();
  const workingMessages: (string | undefined)[] = [];
  const recorded: Partial<ExtensionUIContext> = {
    setStatus: (key, text) => statuses.set(key, text),
    setWorkingMessage: (message) => workingMessages.push(message),
  };
  const nonMethodProperties = new Set<PropertyKey>(["then", "theme"]);
  const uiContext = new Proxy(recorded, {
    get: (target, property) =>
      target[property as keyof ExtensionUIContext] ??
      (nonMethodProperties.has(property) ? undefined : () => undefined),
  }) as ExtensionUIContext;
  return { uiContext, statuses, workingMessages };
}

interface TestSessionOptions {
  piEffortSettings?: Record<string, unknown>;
  uiContext?: ExtensionUIContext;
}

async function createTestSession(
  model: Model<any>,
  thinkingLevel: PiThinkingLevel,
  defaultThinkingLevel?: PiThinkingLevel,
  flags: Record<string, boolean | string> = {},
  options: TestSessionOptions = {}
) {
  const config = makeSessionConfig(options.piEffortSettings);
  const extension = await config.extensionPromise;
  for (const [name, value] of Object.entries(flags)) {
    config.runtime.flagValues.set(name, value);
  }
  const extensionsResult: LoadExtensionsResult = { extensions: [extension], errors: [], runtime: config.runtime };
  const resourceLoader = createResourceLoader(extensionsResult);

  const settingsManager = SettingsManager.create(config.cwd, config.agentDir);
  if (defaultThinkingLevel) {
    settingsManager.applyOverrides({ defaultThinkingLevel });
  }

  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.agentDir,
    model,
    thinkingLevel,
    settingsManager,
    sessionManager,
    resourceLoader,
  });
  await session.bindExtensions({ uiContext: options.uiContext });

  return { session, extension, agentDir: config.agentDir, previousAgentDir: config.previousAgentDir };
}

function cleanupSession(previousAgentDir: string | undefined) {
  if (previousAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

// ─── Basic command tests ────────────────────────────────────────────

test("runtime command changes session thinking level", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    await session.prompt("/effort high");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast command toggles fast mode setting", async () => {
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    let persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, true);

    await session.prompt("/fast off");
    persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, false);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime bare /fast toggles fast mode setting", async () => {
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast");
    let persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, true);

    await session.prompt("/fast");
    persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
    assert.equal(persisted["pi-effort"].fastMode, false);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast injects OpenAI priority service tier for GPT-5 requests", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    const handlers = extension.handlers.get("before_provider_request");
    assert.ok(handlers?.[0]);

    const payload = { model: "gpt-5.5", input: [], stream: true };
    const result = await handlers[0]({ type: "before_provider_request", payload }, { model: xhighModel });

    assert.deepEqual(result, { ...payload, service_tier: "priority" });
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast does not inject service_tier for a non-OpenAI gpt-5 id", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    const handlers = extension.handlers.get("before_provider_request");
    assert.ok(handlers?.[0]);

    const payload = { model: "gpt-5.5", input: [] };
    const result = await handlers[0](
      { type: "before_provider_request", payload },
      { model: { ...xhighModel, provider: "openrouter" } },
    );

    assert.equal(result, undefined);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /fast preserves explicit service tier overrides", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/fast on");
    const handlers = extension.handlers.get("before_provider_request");
    assert.ok(handlers?.[0]);

    const payload = { model: "gpt-5.5", service_tier: "default" };
    const result = await handlers[0]({ type: "before_provider_request", payload }, { model: xhighModel });

    assert.equal(result, undefined);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("new sessions inherit defaultThinkingLevel from Pi settings", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── xhigh pre-validation tests ─────────────────────────────────────

test("runtime rejects xhigh on non-xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const before = session.thinkingLevel;
    await session.prompt("/effort xhigh");
    assert.equal(session.thinkingLevel, before as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime accepts xhigh on xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/effort xhigh");
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── min/max semantic alias tests ───────────────────────────────────

test("runtime /effort max resolves to high on non-xhigh model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /effort max resolves to xhigh on xhigh-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /effort min resolves to minimal on reasoning model", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    await session.prompt("/effort min");
    assert.equal(session.thinkingLevel, "minimal" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── Extension lifecycle surface tests ──────────────────────────────

test("runtime --effort flag resolves aliases on session start", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", { effort: "max" });

  try {
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime model switch clamps xhigh to the new model maximum", async () => {
  const { session, previousAgentDir } = await createTestSession(xhighModel, "xhigh", "xhigh");

  try {
    await session.setModel(reasoningModel);
    assert.equal(session.thinkingLevel, "high" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime model switch clamps reasoning effort to off for non-reasoning models", async () => {
  const { session, previousAgentDir } = await createTestSession(reasoningModel, "high", "high");

  try {
    await session.setModel(plainModel);
    assert.equal(session.thinkingLevel, "off" as PiThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("argument completions expose only effort levels and fast on/off", async () => {
  const { extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.getArgumentCompletions);

    const topLevel = await command.getArgumentCompletions("");
    assert.deepEqual(topLevel?.map((item) => item.value), ["min", "minimal", "low", "medium", "high", "max"]);

    assert.equal(await command.getArgumentCompletions("default "), null);
    assert.equal(await command.getArgumentCompletions("fast "), null);

    const fastCommand = extension.commands.get("fast");
    assert.ok(fastCommand?.getArgumentCompletions);
    const fastCommandOptions = await fastCommand.getArgumentCompletions("");
    assert.deepEqual(fastCommandOptions?.map((item) => item.value), ["on", "off"]);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── max-capable models (tests ported from PR #7) ───────────────────

test("runtime /effort max resolves to max on max-capable and max-only models", async () => {
  for (const model of [maxModel, maxOnlyModel]) {
    const { session, previousAgentDir } = await createTestSession(model, "medium", "medium");
    try {
      await session.prompt("/effort max");
      assert.equal(session.thinkingLevel, "max" as ThinkingLevel, model.id);
    } finally {
      cleanupSession(previousAgentDir);
    }
  }
});

test("runtime --effort max flag resolves to max on a max-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(maxModel, "medium", "medium", { effort: "max" });

  try {
    assert.equal(session.thinkingLevel, "max" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("completions and picker offer min and max for a max-only model", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(maxOnlyModel, "max", "max");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.getArgumentCompletions && command.handler);

    const completions = await command.getArgumentCompletions("");
    assert.deepEqual(completions?.map((item) => item.value), ["min", "max"]);

    let offered: string[] | undefined;
    const errors: string[] = [];
    await command.handler("", {
      model: maxOnlyModel,
      isIdle: () => true,
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return "min";
        },
        notify: (message: string, type: string) => {
          if (type === "error") errors.push(message);
        },
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
    } as any);

    assert.deepEqual(errors, []);
    assert.deepEqual(offered, ["min", "max"]);
    assert.equal(session.thinkingLevel, "max" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

// ─── Display settings tests ─────────────────────────────────────────

test("runtime shows effort in the footer and working message by default", async () => {
  const ui = createRecordingUI();
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", {}, {
    piEffortSettings: { fastMode: true },
    uiContext: ui.uiContext,
  });

  try {
    await session.prompt("/effort high");
    assert.equal(ui.statuses.get("pi-effort-thinking"), "think:high");
    assert.equal(ui.statuses.get("pi-effort-fast"), "fast");
    assert.equal(ui.workingMessages.at(-1), "Working (high effort)...");
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort applies the level picked in the select dialog", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.handler);

    let offered: string[] | undefined;
    await command.handler("", {
      model: reasoningModel,
      isIdle: () => true,
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return "low";
        },
        notify: () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
    } as any);

    assert.deepEqual(offered, ["min", "minimal", "low", "medium", "high", "max"]);
    assert.equal(session.thinkingLevel, "low" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime showModelEffortInFooter false hides the thinking and fast statuses", async () => {
  const ui = createRecordingUI();
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", {}, {
    piEffortSettings: { fastMode: true, showModelEffortInFooter: false },
    uiContext: ui.uiContext,
  });

  try {
    await session.prompt("/effort high");
    assert.equal(ui.statuses.has("pi-effort-thinking"), true);
    assert.equal(ui.statuses.get("pi-effort-thinking"), undefined);
    assert.equal(ui.statuses.get("pi-effort-fast"), undefined);
    assert.equal(ui.workingMessages.at(-1), "Working (high effort)...");
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort cancelled in the dialog leaves the level unchanged", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.handler);

    await command.handler("", {
      model: reasoningModel,
      isIdle: () => true,
      hasUI: true,
      ui: {
        select: async () => undefined,
        notify: () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
    } as any);

    assert.equal(session.thinkingLevel, "medium" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime showModelEffortInWorkingMessage false leaves the working message alone", async () => {
  const ui = createRecordingUI();
  const { session, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", {}, {
    piEffortSettings: { showModelEffortInWorkingMessage: false },
    uiContext: ui.uiContext,
  });

  try {
    await session.prompt("/effort high");
    assert.deepEqual(ui.workingMessages, []);
    assert.equal(ui.statuses.get("pi-effort-thinking"), "think:high");
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime clears its working message once showModelEffortInWorkingMessage turns false", async () => {
  const ui = createRecordingUI();
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", {}, {
    uiContext: ui.uiContext,
  });

  try {
    await session.prompt("/effort high");
    assert.equal(ui.workingMessages.at(-1), "Working (high effort)...");

    writePiEffortSettings(agentDir, { showModelEffortInWorkingMessage: false });
    await session.prompt("/effort low");
    const afterOff = ui.workingMessages.length;
    assert.equal(ui.workingMessages.at(-1), undefined);

    await session.prompt("/effort medium");
    assert.equal(ui.workingMessages.length, afterOff);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime picks up showModelEffortInFooter changes mid-session", async () => {
  const ui = createRecordingUI();
  const { session, agentDir, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium", {}, {
    piEffortSettings: { fastMode: true },
    uiContext: ui.uiContext,
  });

  try {
    await session.prompt("/effort high");
    assert.equal(ui.statuses.get("pi-effort-thinking"), "think:high");

    writePiEffortSettings(agentDir, { fastMode: true, showModelEffortInFooter: false });
    await session.prompt("/effort low");
    assert.equal(ui.statuses.get("pi-effort-thinking"), undefined);
    assert.equal(ui.statuses.get("pi-effort-fast"), undefined);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort offers xhigh and resolves max for an xhigh-capable model", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(xhighModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.handler);

    let offered: string[] | undefined;
    await command.handler("", {
      model: xhighModel,
      isIdle: () => true,
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          offered = options;
          return "max";
        },
        notify: () => {},
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
    } as any);

    assert.deepEqual(offered, ["min", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(session.thinkingLevel, "xhigh" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("bare /effort without a UI reports usage and leaves the level unchanged", async () => {
  const { session, extension, previousAgentDir } = await createTestSession(reasoningModel, "medium", "medium");

  try {
    const command = extension.commands.get("effort");
    assert.ok(command?.handler);

    let selectCalled = false;
    const errors: string[] = [];
    await command.handler("", {
      model: reasoningModel,
      isIdle: () => true,
      hasUI: false,
      ui: {
        select: async () => {
          selectCalled = true;
          return "low";
        },
        notify: (message: string, type: string) => {
          if (type === "error") errors.push(message);
        },
        setStatus: () => {},
        setWorkingMessage: () => {},
      },
    } as any);

    assert.equal(selectCalled, false);
    assert.deepEqual(errors, [USAGE]);
    assert.equal(session.thinkingLevel, "medium" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});
