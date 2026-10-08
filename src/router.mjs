import { TypeSafeClient } from "@typesafe-ai/sdk";
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

// The SDK's defaults (10s per attempt, 2 retries, no total budget) are far too slow for a
// per-prompt hot path, so the timeout, retry count and an outer deadline are all pinned.
// Built lazily because the constructor throws when no key is present, and a missing key
// should degrade to "no routing", not stop the session from starting.
let client;
function getClient() {
  client ??= new TypeSafeClient({
    apiKey: process.env.JEV_API_KEY ?? process.env.TYPESAFE_API_KEY,
    timeout: THRESHOLDS.jevTimeoutMs,
    retry: { maxRetries: THRESHOLDS.jevMaxRetries, backoffInitialMs: 150, backoffMaxMs: 400 },
    logLevel: "warn", // never "debug": request bodies contain the user's prompt
  });
  return client;
}

/**
 * Asks Jev which tier fits this prompt. Returns null on any failure, which the policy
 * layer reads as "keep the current model" — routing must never block a prompt, so
 * everything, including building the request, happens inside the try.
 *
 * @param {object} input
 * @param {string} input.prompt        user prompt
 * @param {string} input.current       model currently in use
 * @param {number} input.contextTokens approximate conversation size
 * @param {Array<{id: string, tier: string, description?: string}>} input.models
 * @param {string} [input.taskType]    detected from the prompt when omitted
 * @returns {Promise<?{choice: string, confidence: number, probabilities: object, metrics: object, taskType: string, ms: number}>}
 */
export async function askJev({ prompt, current, contextTokens, models, taskType }) {
  if (!models?.length) return null;
  const started = Date.now();
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), THRESHOLDS.jevDeadlineMs);
  try {
    taskType ??= resolveTaskType(prompt);
    const request = {
      state: {
        request: prompt,
        session: { current_model: current, context_tokens: contextTokens, task_type: TASK_TYPES[taskType]?.name },
        environment: { available_models: models.map((model) => model.id) },
      },
      questions: { ...questionsFor(taskType), model: questionForModels(models, taskType) },
    };
    const result = await getClient().systemOne(request, { signal: abort.signal });
    const { model: answer, ...scores } = result.answers;
    const metrics = { contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1) };
    for (const [key, value] of Object.entries(scores)) {
      if (typeof value?.score === "number") metrics[camel(key)] = value.score / COMPLEXITY_MAX_SCORE;
    }
    return { ...answer, request, response: result, metrics, taskType, ms: Date.now() - started };
  } catch (err) {
    log(`routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

/** Calls a routing function, turning any error into "no answer" so the current model is kept. */
export async function routeSafely(route, input) {
  try {
    return await route(input);
  } catch (err) {
    log(`routing failed, keeping ${input.current}: ${err.message}`);
    return null;
  }
}

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
