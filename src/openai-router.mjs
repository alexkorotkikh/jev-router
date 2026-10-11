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

/** The only model the Decisions API supports today. */
export const OPENAI_DEFAULT_MODEL = "gpt-6-luna";
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** A dedicated key wins so a Codex session's own auth is never confused with the router's. */
export const openaiKey = () => process.env.JEV_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY;

const text = (value) => (Array.isArray(value) ? value.join(" ") : String(value));

/** Flattens a Jev choice criterion ({model, what, signals, not_for}) into one description. */
const describe = ({ model, what, signals, not_for }) =>
  [model, what && `For: ${what}`, signals?.length && `Signals: ${signals.join("; ")}`, not_for && `Not for: ${not_for}`]
    .filter(Boolean)
    .join(" ");

/** Translates the Jev-shaped questions built in config.mjs into Decisions API questions. */
export function toDecisionQuestions(questions) {
  return Object.entries(questions).map(([name, question]) =>
    question.type === "choice"
      ? {
          type: "choice",
          name,
          instructions: text(question.instructions),
          choices: Object.entries(question.criteria).map(([value, criterion]) => ({
            value,
            description: describe(criterion),
          })),
        }
      : {
          type: "score",
          name,
          instructions: text(question.instructions),
          levels: question.criteria.map((label) => ({ label })),
        },
  );
}

/** The routing state as plain text, the Decisions API's shared evidence for every question. */
const decisionInput = ({ request, session, environment }) =>
  [
    `User request to an AI coding assistant:\n${request}`,
    `Current model: ${session.current_model}`,
    `Conversation size: ~${session.context_tokens} tokens`,
    `Task type: ${session.task_type ?? "unknown"}`,
    `Available models: ${environment.available_models.join(", ")}`,
  ].join("\n\n");

/** Decisions API probabilities arrive as [{value, probability}]; Jev uses {value: probability}. */
const probabilityMap = (list = []) => Object.fromEntries(list.map(({ value, probability }) => [value, probability]));

/**
 * Same contract as askJev, answered by OpenAI's Decisions API (POST /v1/decisions) instead of
 * TypeSafe Jev. Returns null on any failure so the policy layer keeps the current model.
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
    const request = {
      state: {
        request: prompt,
        session: { current_model: current, context_tokens: contextTokens, task_type: TASK_TYPES[taskType]?.name },
        environment: { available_models: models.map((model) => model.id) },
      },
      questions: { ...questionsFor(taskType), model: questionForModels(models, taskType) },
    };
    const body = {
      model: process.env.JEV_OPENAI_MODEL || OPENAI_DEFAULT_MODEL,
      input: decisionInput(request.state),
      questions: toDecisionQuestions(request.questions),
    };
    const base = (process.env.JEV_OPENAI_BASE_URL || OPENAI_DEFAULT_BASE_URL).replace(/\/$/, "");
    const res = await fetch(`${base}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const decision = await res.json();

    const answers = {};
    for (const answer of decision.answers ?? []) {
      if (answer.type === "refusal") continue;
      answers[answer.name] = { ...answer, probabilities: probabilityMap(answer.probabilities) };
    }
    const choice = answers.model;
    if (choice?.type !== "choice" || !models.some((m) => m.id === choice.choice)) {
      throw new Error("OpenAI returned no valid model");
    }
    const metrics = { contextSize: Math.min(contextTokens / CONTEXT_WINDOW_TOKENS, 1) };
    for (const [name, answer] of Object.entries(answers)) {
      if (answer.type === "score") metrics[camel(name)] = answer.score / COMPLEXITY_MAX_SCORE;
    }
    const response = { answers, model: decision.model, usage: decision.usage };
    return {
      choice: choice.choice,
      confidence: choice.confidence,
      probabilities: choice.probabilities,
      request,
      response,
      metrics,
      taskType,
      ms: Date.now() - started,
    };
  } catch (err) {
    log(`openai routing failed, keeping ${current}: ${err.message}`);
    return null;
  } finally {
    clearTimeout(deadline);
  }
}

const camel = (key) => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
