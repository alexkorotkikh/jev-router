import test from "node:test";
import assert from "node:assert/strict";
import { TIER_NAMES } from "../src/config.mjs";
import { askOpenAI } from "../src/openai-router.mjs";
import { routerConfigured, routerName, takeRouterFlags } from "../src/router.mjs";

const models = TIER_NAMES.map((tier) => ({ id: `model-${tier}`, tier }));

function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  return Promise.resolve().then(fn).finally(restore);
}

test("takeRouterFlags strips its own flags and exports them", () => {
  const env = {};
  const rest = takeRouterFlags(["--resume", "--router", "openai", "--router-model=gpt-x", "-p", "hi"], env);
  assert.deepEqual(rest, ["--resume", "-p", "hi"]);
  assert.equal(env.JEV_ROUTER, "openai");
  assert.equal(env.JEV_OPENAI_MODEL, "gpt-x");
  assert.deepEqual(takeRouterFlags(["--router=jev"], env), []);
  assert.equal(env.JEV_ROUTER, "jev");
});

test("takeRouterFlags leaves arguments after -- alone and rejects bad values", () => {
  const env = {};
  assert.deepEqual(takeRouterFlags(["--", "--router", "openai"], env), ["--", "--router", "openai"]);
  assert.equal(env.JEV_ROUTER, undefined);
  assert.throws(() => takeRouterFlags(["--router", "gemini"], env), /must be one of/);
  assert.throws(() => takeRouterFlags(["--router"], env), /needs a value/);
});

test("the openai backend needs its own key", () =>
  withEnv({ JEV_ROUTER: "openai", OPENAI_API_KEY: undefined, JEV_OPENAI_API_KEY: undefined, JEV_API_KEY: "x" }, () => {
    assert.equal(routerName(), "openai");
    assert.equal(routerConfigured(), false);
    process.env.OPENAI_API_KEY = "sk";
    assert.equal(routerConfigured(), true);
  }));

test("askOpenAI maps a structured reply into the Jev answer shape", () =>
  withEnv({ JEV_OPENAI_API_KEY: "sk-test", JEV_OPENAI_MODEL: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      const content = JSON.stringify({
        model: "model-sonnet",
        confidence: 0.8,
        reasoning_required: 4,
        task_complexity: 9,
        tool_complexity: 0,
      });
      return new Response(JSON.stringify({ model: "gpt-5-mini", choices: [{ message: { content } }] }));
    };
    try {
      const answer = await askOpenAI({ prompt: "fix the bug", current: "model-opus", contextTokens: 0, models, taskType: "coding" });
      assert.equal(sent.auth, "Bearer sk-test");
      assert.match(sent.url, /\/chat\/completions$/);
      assert.deepEqual(sent.body.response_format.json_schema.schema.properties.model.enum, models.map((m) => m.id));
      assert.equal(answer.choice, "model-sonnet");
      assert.equal(answer.confidence, 0.8);
      assert.equal(answer.metrics.taskComplexity, 1);
      assert.equal(answer.metrics.toolComplexity, 0);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("askOpenAI returns null on an unknown model or HTTP error", () =>
  withEnv({ JEV_OPENAI_API_KEY: "sk-test" }, async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ choices: [{ message: { content: '{"model":"nope","confidence":1}' } }] }));
      assert.equal(await askOpenAI({ prompt: "x", current: "model-opus", contextTokens: 0, models }), null);
      globalThis.fetch = async () => new Response("boom", { status: 500 });
      assert.equal(await askOpenAI({ prompt: "x", current: "model-opus", contextTokens: 0, models }), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
