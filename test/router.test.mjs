import test from "node:test";
import assert from "node:assert/strict";
import { questionForModels, questionsFor, TASK_TYPE_KEYS, TIER_NAMES } from "../src/config.mjs";
import { askJev } from "../src/router.mjs";

const models = TIER_NAMES.map((tier) => ({ id: `model-${tier}`, tier }));

test("every task type builds a model question with guidance for every tier", () => {
  for (const taskType of TASK_TYPE_KEYS) {
    const question = questionForModels(models, taskType);
    for (const { id } of models) {
      const entry = question.criteria[id];
      assert.equal(typeof entry.what, "string", `${taskType}/${id} has no guidance`);
      assert(entry.signals.length > 0, `${taskType}/${id} has no signals`);
      assert.equal(typeof entry.not_for, "string", `${taskType}/${id} has no not_for`);
    }
  }
});

test("every task type asks API-valid score questions including reasoning", () => {
  for (const taskType of TASK_TYPE_KEYS) {
    const scores = Object.values(questionsFor(taskType)).filter((q) => q.type === "score");
    assert(scores.length >= 3, `${taskType} asks too few questions`);
    assert("reasoning_required" in questionsFor(taskType));
    for (const question of scores) {
      assert(question.criteria.every((description) => typeof description === "string"));
      assert(question.criteria.length <= 10);
    }
  }
});

test("askJev returns null instead of throwing when routing cannot run", async () => {
  const saved = { jev: process.env.JEV_API_KEY, typesafe: process.env.TYPESAFE_API_KEY };
  delete process.env.JEV_API_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    for (const taskType of [...TASK_TYPE_KEYS, undefined, "not-a-type"]) {
      const result = await askJev({ prompt: "write the PRD", current: "model-opus", contextTokens: 0, models, taskType });
      assert.equal(result, null, `taskType ${taskType} did not degrade to null`);
    }
  } finally {
    if (saved.jev !== undefined) process.env.JEV_API_KEY = saved.jev;
    if (saved.typesafe !== undefined) process.env.TYPESAFE_API_KEY = saved.typesafe;
  }
});
