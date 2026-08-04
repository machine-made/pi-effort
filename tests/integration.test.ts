import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ThinkingLevel } from "@mariozechner/pi-ai";
import { InMemoryCredentialStore } from "@mariozechner/pi-ai";
import {
  createAgentSession,
  createEventBus,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type LoadExtensionsResult,
  type ResourceLoader,
} from "@mariozechner/pi-coding-agent";
import {
  createExtensionRuntime,
  loadExtensionFromFactory,
} from "../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js";
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
  provider: "openrouter",
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
  provider: "opencode-go",
  baseUrl: "https://opencode.ai/zen/go/v1",
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
  thinkingLevelMap: {
    minimal: null,
    low: null,
    medium: null,
    high: null,
    max: "max",
  },
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

function makeSessionConfig() {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-effort-runtime-"));
  const agentDir = join(tempRoot, "agent");
  const cwd = join(tempRoot, "cwd");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });

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

async function createTestSession(
  model: Model<any>,
  thinkingLevel: PiThinkingLevel,
  defaultThinkingLevel?: PiThinkingLevel,
  flags: Record<string, boolean | string> = {}
) {
  const config = makeSessionConfig();
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

  const credentials = new InMemoryCredentialStore();
  await credentials.modify("openrouter", async () => ({ type: "api_key", key: "test" }));
  const modelRuntime = await ModelRuntime.create({ credentials, authPath: join(config.agentDir, "auth.json"), modelsPath: join(config.agentDir, "models.json"), allowModelNetwork: false });
  const sessionManager = SessionManager.inMemory();

  const { session } = await createAgentSession({
    cwd: config.cwd,
    agentDir: config.agentDir,
    model,
    thinkingLevel,
    settingsManager,
    modelRuntime,
    sessionManager,
    resourceLoader,
  });
  await session.bindExtensions({});

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
    const result = await handlers[0]({ type: "before_provider_request", payload }, {});

    assert.deepEqual(result, { ...payload, service_tier: "priority" });
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
    const result = await handlers[0]({ type: "before_provider_request", payload }, {});

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

test("runtime /effort max resolves to max on max-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(maxModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "max" as ThinkingLevel);
  } finally {
    cleanupSession(previousAgentDir);
  }
});

test("runtime /effort max resolves to max on max-only model", async () => {
  const { session, previousAgentDir } = await createTestSession(maxOnlyModel, "medium", "medium");

  try {
    await session.prompt("/effort max");
    assert.equal(session.thinkingLevel, "max" as ThinkingLevel);
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

test("runtime --effort max flag resolves to max on max-capable model", async () => {
  const { session, previousAgentDir } = await createTestSession(maxModel, "medium", "medium", { effort: "max" });

  try {
    assert.equal(session.thinkingLevel, "max" as ThinkingLevel);
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
