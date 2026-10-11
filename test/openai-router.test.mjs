import test from "node:test";
import assert from "node:assert/strict";
import { questionForModels, questionsFor, TIER_NAMES } from "../src/config.mjs";
import { askOpenAI, toDecisionQuestions } from "../src/openai-router.mjs";
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

test("toDecisionQuestions translates Jev questions into Decisions API questions", () => {
  const questions = toDecisionQuestions({ ...questionsFor("coding"), model: questionForModels(models, "coding") });
  const choice = questions.find((q) => q.name === "model");
  assert.equal(choice.type, "choice");
  assert.equal(typeof choice.instructions, "string");
  assert.deepEqual(choice.choices.map((c) => c.value), models.map((m) => m.id));
  assert(choice.choices.every((c) => /Not for:/.test(c.description)));
  const score = questions.find((q) => q.name === "reasoning_required");
  assert.equal(score.type, "score");
  assert.equal(score.levels.length, 10);
  assert.equal(score.levels[0].label, "None");
});

test("askOpenAI maps a Decisions API reply into the Jev answer shape", () =>
  withEnv({ JEV_OPENAI_API_KEY: "sk-test", JEV_OPENAI_MODEL: undefined }, async () => {
    const realFetch = globalThis.fetch;
    let sent;
    globalThis.fetch = async (url, init) => {
      sent = { url, body: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({
        model: "gpt-6-luna",
        answers: [
          {
            type: "choice",
            name: "model",
            choice: "model-sonnet",
            probabilities: [{ value: "model-sonnet", probability: 0.85 }, { value: "model-opus", probability: 0.15 }],
            confidence: 0.8,
          },
          { type: "score", name: "task_complexity", score: 9, probabilities: [], confidence: 0.5 },
          { type: "score", name: "tool_complexity", score: 0, probabilities: [], confidence: 0.5 },
          { type: "refusal", name: "reasoning_required" },
        ],
      }));
    };
    try {
      const answer = await askOpenAI({ prompt: "fix the bug", current: "model-opus", contextTokens: 0, models, taskType: "coding" });
      assert.equal(sent.auth, "Bearer sk-test");
      assert.match(sent.url, /\/decisions$/);
      assert.equal(sent.body.model, "gpt-6-luna");
      assert.match(sent.body.input, /fix the bug/);
      assert.equal(answer.choice, "model-sonnet");
      assert.equal(answer.confidence, 0.8);
      assert.deepEqual(answer.probabilities, { "model-sonnet": 0.85, "model-opus": 0.15 });
      assert.equal(answer.metrics.taskComplexity, 1);
      assert.equal(answer.metrics.toolComplexity, 0);
      assert.equal(answer.metrics.reasoningRequired, undefined);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));

test("askOpenAI returns null on an unknown model or HTTP error", () =>
  withEnv({ JEV_OPENAI_API_KEY: "sk-test" }, async () => {
    const realFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ answers: [{ type: "choice", name: "model", choice: "nope", confidence: 1 }] }));
      assert.equal(await askOpenAI({ prompt: "x", current: "model-opus", contextTokens: 0, models }), null);
      globalThis.fetch = async () => new Response("boom", { status: 500 });
      assert.equal(await askOpenAI({ prompt: "x", current: "model-opus", contextTokens: 0, models }), null);
    } finally {
      globalThis.fetch = realFetch;
    }
  }));
