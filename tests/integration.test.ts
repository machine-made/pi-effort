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
