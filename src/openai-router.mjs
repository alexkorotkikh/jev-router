import {
  COMPLEXITY_MAX_SCORE,
  CONTEXT_WINDOW_TOKENS,
  questionForModels,
  questionsFor,
  resolveTaskType,
  TASK_TYPES,
  THRESHOLDS,
} from "./config.mjs";
import { log } from "./log.mjs";

export const OPENAI_DEFAULT_MODEL = "gpt-5-mini";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A dedicated key wins so a Codex session's own auth is never confused with the router's. */
export const openaiKey = () => process.env.JEV_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = [
  "You are a model router for an AI coding assistant.",
  "Read the user's request and session state, answer every scored question on its rubric",
  "(integer index into the rubric, 0 is the lowest), then pick exactly one model id from the",
  "allowed list following the model question's instructions and per-model guidance.",
  "Report your confidence in the model choice as a number from 0 to 1.",
  "Do not perform the request. Reply with JSON only.",
].join(" ");

/** JSON schema for the structured reply, so the model can only name an available model id. */
function replySchema(scores, modelIds) {
  const properties = {
    model: { type: "string", enum: modelIds },
    confidence: { type: "number" },
  };
  for (const [key, question] of Object.entries(scores)) {
    // Range goes in the description and is clamped on read; not every model supports
    // minimum/maximum under strict structured outputs.
    properties[key] = { type: "integer", description: `0 to ${question.criteria.length - 1}` };
  }
  return {
    name: "routing_decision",
    strict: true,
    schema: { type: "object", additionalProperties: false, properties, required: Object.keys(properties) },
  };
}

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

/**
 * Same contract as askJev, answered by an OpenAI chat model instead of TypeSafe Jev. Returns
 * null on any failure so the policy layer keeps the current model.
 */
export async function askOpenAI({ prompt, current, contextTokens, models, taskType }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.openaiDeadlineMs);
  try {
    const key = openaiKey();
    if (!key) throw new Error("no OPENAI_API_KEY or JEV_OPENAI_API_KEY set");
    taskType ??= resolveTaskType(prompt);
    const scores = questionsFor(taskType);
    const request = {
      state: {
        request: prompt,
        session: { current_model: current, context_tokens: contextTokens, task_type: TASK_TYPES[taskType]?.name },
        environment: { available_models: models.map((model) => model.id) },
      },
      questions: { ...scores, model: questionForModels(models, taskType) },
    };
    const model = process.env.JEV_OPENAI_MODEL || OPENAI_DEFAULT_MODEL;
    const effort = process.env.JEV_OPENAI_REASONING_EFFORT ?? (/^(gpt-5|o\d)/.test(model) ? "minimal" : "");
    const body = {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(request) },
      ],
      response_format: { type: "json_schema", json_schema: replySchema(scores, request.state.environment.available_models) },
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    const base = (process.env.JEV_OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const completion = await res.json();
    const reply = JSON.parse(completion.choices?.[0]?.message?.content ?? "null");
    if (!reply || !models.some((m) => m.id === reply.model)) throw new Error("OpenAI returned no valid model");

    const confidence = clamp(Number(reply.confidence) || 0, 0, 1);
    const answers = { model: { type: "choice", choice: reply.model, confidence, probabilities: { [reply.model]: confidence } } };
    const metrics = { contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1) };
    for (const [name, question] of Object.entries(scores)) {
      const value = clamp(Math.round(Number(reply[name]) || 0), 0, question.criteria.length - 1);
      answers[name] = { type: "score", score: value, confidence };
      metrics[camel(name)] = value / COMPLEXITY_MAX_SCORE;
    }
    const response = { answers, model: completion.model, usage: completion.usage };
    return { ...answers.model, request, response, metrics, taskType, ms: Date.now() - started };
  } catch (err) {
    log(`openai routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
