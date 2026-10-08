import test from "node:test";
import assert from "node:assert/strict";
import {
  addOpenCodeProvider,
  createOpenCodePlugin,
  createOpenCodeV2Plugin,
  opencodeModels,
  opencodeTierOf,
  opencodeV2Models,
} from "../src/opencode-plugin.mjs";
import { opencodeArgs, opencodeConfig } from "../src/opencode-cli.mjs";
import { readStatus } from "../src/status.mjs";

const catalog = {
  connected: ["anthropic", "openai"],
  all: [{
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-haiku-4-5": {
        id: "claude-haiku-4-5",
        name: "Claude Haiku 4.5",
        release_date: "2025-10-01",
        tool_call: true,
        limit: { context: 200000 },
      },
      "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        release_date: "2026-09-01",
        tool_call: true,
        limit: { context: 200000 },
      },
      "claude-opus-5": {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        release_date: "2026-09-01",
        tool_call: true,
        limit: { context: 200000 },
      },
    },
  }, {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5-mini": { id: "gpt-5-mini", name: "GPT-5 mini", tool_call: true },
      "gpt-5": { id: "gpt-5", name: "GPT-5", tool_call: true },
    },
  }],
};

test("maps OpenCode model families onto shared Jev tiers", () => {
  assert.equal(opencodeTierOf("claude-haiku-4-5"), "haiku");
  assert.equal(opencodeTierOf("gpt-5-mini"), "haiku");
  assert.equal(opencodeTierOf("claude-sonnet-5"), "sonnet");
  assert.equal(opencodeTierOf("claude-opus-5"), "opus");
  assert.equal(opencodeTierOf("gpt-6-astra"), "fable");
  assert.equal(opencodeTierOf("unknown-model"), null);
});

test("uses exact models from a connected OpenCode provider", () => {
  assert.deepEqual(opencodeModels(catalog, {}).map(({ id, tier }) => ({ id, tier })), [
    { id: "anthropic/claude-haiku-4-5", tier: "haiku" },
    { id: "anthropic/claude-sonnet-5", tier: "sonnet" },
    { id: "anthropic/claude-opus-5", tier: "opus" },
  ]);
  assert.deepEqual(
    opencodeModels(catalog, { JEV_OPENCODE_PROVIDER: "openai" }).map(({ id, tier }) => ({ id, tier })),
    [
      { id: "openai/gpt-5-mini", tier: "haiku" },
      { id: "openai/gpt-5", tier: "sonnet" },
    ],
  );
});

test("honors explicit OpenCode tier model configuration", () => {
  const models = opencodeModels(catalog, {
    JEV_OPENCODE_FAST_MODEL: "openai/gpt-5-mini",
    JEV_OPENCODE_STRONG_MODEL: "anthropic/claude-opus-5",
  });
  assert.deepEqual(models.map(({ id, tier }) => ({ id, tier })), [
    { id: "openai/gpt-5-mini", tier: "haiku" },
    { id: "anthropic/claude-opus-5", tier: "opus" },
  ]);
});

test("reads exact models from OpenCode v2's active registry", () => {
  const models = opencodeV2Models([
    { providerID: "jev", id: "auto", capabilities: { tools: true } },
    { providerID: "openai", id: "gpt-5-mini", name: "GPT-5 mini", capabilities: { tools: true } },
    { providerID: "openai", id: "gpt-5", name: "GPT-5", capabilities: { tools: true } },
  ]);
  assert.deepEqual(models.map(({ id, tier }) => ({ id, tier })), [
    { id: "openai/gpt-5-mini", tier: "haiku" },
    { id: "openai/gpt-5", tier: "sonnet" },
  ]);
});

test("prefers standard models over Fast Mode variants", () => {
  const models = opencodeV2Models([
    { providerID: "anthropic", id: "claude-opus-5-fast", capabilities: { tools: true } },
    { providerID: "anthropic", id: "claude-opus-5-5-fast", capabilities: { tools: true } },
    { providerID: "anthropic", id: "claude-opus-5-5", capabilities: { tools: true } },
    { providerID: "anthropic", id: "claude-opus-5", capabilities: { tools: true } },
  ]);
  assert.deepEqual(models.map(({ id }) => id), [
    "anthropic/claude-opus-5-5",
    "anthropic/claude-opus-5",
    "anthropic/claude-opus-5-fast",
    "anthropic/claude-opus-5-5-fast",
  ]);
});

test("registers a virtual Jev provider and builds a temporary config overlay", () => {
  const config = addOpenCodeProvider({});
  assert.equal(config.provider.jev.name, "Jev Router");
  assert.equal(config.provider.jev.models.auto.name, "Jev Router");

  const overlay = JSON.parse(opencodeConfig('{"plugin":["existing"],"theme":"dark"}', "file:///plugin.mjs"));
  assert.equal(overlay.model, "jev/auto");
  assert.equal(overlay.provider.jev.models.auto.name, "Jev Router");
  assert.deepEqual(overlay.plugin, ["existing", "file:///plugin.mjs"]);
  assert.equal(overlay.theme, "dark");
  assert.deepEqual(opencodeArgs(["run", "hello"]), ["run", "--standalone", "hello"]);
  assert.deepEqual(opencodeArgs(["--log-level", "debug", "run", "hello"]), [
    "--log-level", "debug", "run", "--standalone", "hello",
  ]);
  assert.deepEqual(opencodeArgs(["run", "--standalone", "hello"]), ["run", "--standalone", "hello"]);
  assert.deepEqual(opencodeArgs(["debug", "config"]), ["debug", "config"]);
  assert.deepEqual(opencodeArgs(["--version"]), ["--version"]);
});

test("routes only the virtual model before OpenCode resolves it", async () => {
  const toasts = [];
  const client = {
    provider: { list: async () => ({ data: catalog }) },
    session: { messages: async () => ({ data: [] }) },
    tui: { showToast: async (value) => void toasts.push(value) },
  };
  const plugin = createOpenCodePlugin({
    route: async ({ prompt, models }) => {
      assert.equal(prompt, "debug this race");
      assert.deepEqual(models.map((model) => model.id), [
        "anthropic/claude-haiku-4-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-opus-5",
      ]);
      return { choice: "anthropic/claude-opus-5", confidence: 0.91, ms: 1 };
    },
  });
  const hooks = await plugin({ client });
  const output = {
    message: { model: { providerID: "jev", modelID: "auto" } },
    parts: [{ type: "text", text: "debug this race" }],
  };
  await hooks["chat.message"]({ sessionID: `test-${process.pid}` }, output);
  assert.deepEqual(output.message.model, {
    providerID: "anthropic",
    modelID: "claude-opus-5",
  });
  assert.match(toasts[0].body.message, /anthropic\/claude-opus-5/);
  assert.equal(readStatus(`opencode-test-${process.pid}`).model, "anthropic/claude-opus-5");

  const manual = {
    message: { model: { providerID: "openai", modelID: "gpt-5" } },
    parts: [{ type: "text", text: "leave this alone" }],
  };
  await hooks["chat.message"]({ sessionID: "manual" }, manual);
  assert.deepEqual(manual.message.model, { providerID: "openai", modelID: "gpt-5" });
});

test("OpenCode v2 switches the admitted prompt and detects later manual control", async () => {
  const sessionID = `v2-${process.pid}`;
  const session = { model: { providerID: "jev", id: "auto" } };
  const switches = [];
  let hook;
  const ctx = {
    model: { list: async () => [
      { providerID: "openai", id: "gpt-5-mini", name: "GPT-5 mini", capabilities: { tools: true } },
      { providerID: "openai", id: "gpt-5", name: "GPT-5", capabilities: { tools: true } },
    ] },
    session: {
      hook: async (name, callback) => {
        assert.equal(name, "prompt");
        hook = callback;
        return { dispose: async () => {} };
      },
      get: async () => session,
      context: async () => [],
      switchModel: async ({ model }) => {
        switches.push(model);
        session.model = model;
      },
    },
  };
  const setup = createOpenCodeV2Plugin({
    route: async () => ({ choice: "openai/gpt-5-mini", confidence: 0.92, ms: 1 }),
  });
  const dispose = await setup(ctx);
  await hook({ sessionID, prompt: { text: "rename this variable" } });
  assert.deepEqual(switches[0], { providerID: "openai", id: "gpt-5-mini" });

  await hook({ sessionID, prompt: { text: "format this file" } });
  assert.equal(switches.length, 2, "the model selected by Jev keeps routing active");

  session.model = { providerID: "openai", id: "gpt-5" };
  await hook({ sessionID, prompt: { text: "manual model" } });
  assert.equal(switches.length, 2, "a different model selected by the user pauses routing");
  await dispose();
});

test("OpenCode v2 waits for an asynchronously projected model switch", async () => {
  const sessionID = `v2-projection-${process.pid}`;
  const session = { model: { providerID: "jev", id: "auto" } };
  let hook;
  let projected = false;
  const ctx = {
    model: { list: async () => [
      { providerID: "anthropic", id: "claude-haiku-4-5", capabilities: { tools: true } },
      { providerID: "anthropic", id: "claude-opus-5", capabilities: { tools: true } },
    ] },
    session: {
      hook: async (_name, callback) => {
        hook = callback;
        return { dispose: async () => {} };
      },
      get: async () => session,
      context: async () => [],
      switchModel: async ({ model }) => {
        setTimeout(() => {
          session.model = model;
          projected = true;
        }, 10);
      },
    },
  };
  const setup = createOpenCodeV2Plugin({
    route: async () => ({ choice: "anthropic/claude-opus-5", confidence: 0.9, ms: 1 }),
  });
  const dispose = await setup(ctx);

  await hook({ sessionID, prompt: { text: "use opus" } });

  assert.equal(projected, true, "the hook must not release the prompt before projection catches up");
  assert.deepEqual(session.model, { providerID: "anthropic", id: "claude-opus-5" });
  await dispose();
});

test("a routing error keeps a real model instead of failing the prompt", async () => {
  const client = {
    provider: { list: async () => ({ data: catalog }) },
    session: { messages: async () => ({ data: [] }) },
  };
  const plugin = createOpenCodePlugin({
    route: async () => {
      throw new Error("routing exploded");
    },
  });
  const hooks = await plugin({ client });
  const output = {
    message: { model: { providerID: "jev", modelID: "auto" } },
    parts: [{ type: "text", text: "ping" }],
  };
  await hooks["chat.message"]({ sessionID: `throw-${process.pid}` }, output);
  assert.deepEqual(output.message.model, { providerID: "anthropic", modelID: "claude-opus-5" });
});
