import { availableTiers, shouldUseExactModel } from "./config.mjs";
import { decide } from "./policy.mjs";
import { askJev, routeSafely } from "./router.mjs";
import { writeDecision } from "./status.mjs";

export const OPENCODE_PROVIDER = "jev";
export const OPENCODE_AUTO_MODEL = "auto";

const MODEL_ENV = {
  haiku: "JEV_OPENCODE_FAST_MODEL",
  sonnet: "JEV_OPENCODE_BALANCED_MODEL",
  opus: "JEV_OPENCODE_STRONG_MODEL",
  fable: "JEV_OPENCODE_LONG_MODEL",
};

const PROVIDER_PRIORITY = [
  "anthropic",
  "openai",
  "github-copilot",
  "opencode",
  "google",
  "openrouter",
];

/** Map model families from OpenCode's provider catalog onto Jev's shared tiers. */
export function opencodeTierOf(model) {
  const id = String(model ?? "").toLowerCase();
  if (/(?:fable|astra|\blong\b)/.test(id)) return "fable";
  if (/(?:haiku|luna|flash|\bmini\b|\bnano\b|\blite\b|instant)/.test(id)) return "haiku";
  if (/(?:opus|\bsol\b|\bmax\b|ultra|\bpro\b|\bo[134](?:-|\b))/.test(id)) return "opus";
  if (/(?:sonnet|terra|claude|gpt|gemini|deepseek|qwen|kimi|glm|grok|codestral)/.test(id)) {
    return "sonnet";
  }
  return null;
}

const splitModel = (value) => {
  const [providerID, ...rest] = String(value ?? "").split("/");
  return rest.length ? { providerID, modelID: rest.join("/") } : null;
};

const descriptionOf = (provider, model) =>
  [
    `${provider.name ?? provider.id} ${model.name ?? model.id}`,
    model.release_date && `released ${model.release_date}`,
    model.limit?.context && `${model.limit.context} context tokens`,
  ].filter(Boolean).join("; ");

const isFastModel = (model) => /(?:^|[-_/])fast(?:$|[-_/])/i.test(model.id);

const compareCandidates = (a, b) =>
  Number(isFastModel(a)) - Number(isFastModel(b)) ||
  b.released.localeCompare(a.released) ||
  b.id.localeCompare(a.id);

/** Exact models Jev may choose, limited to one connected OpenCode provider by default. */
export function opencodeModels(catalog, env = process.env) {
  const providers = catalog?.all ?? [];
  const connected = new Set(catalog?.connected ?? []);
  const configured = Object.entries(MODEL_ENV).flatMap(([tier, name]) => {
    const parsed = splitModel(env[name]);
    if (!parsed || (tier === "fable" && !availableTiers().includes("fable"))) return [];
    const provider = providers.find((item) => item.id === parsed.providerID);
    const model = provider?.models?.[parsed.modelID];
    if (!provider || !model || !connected.has(provider.id)) return [];
    return [{
      id: `${provider.id}/${model.id ?? parsed.modelID}`,
      providerID: provider.id,
      modelID: model.id ?? parsed.modelID,
      tier,
      description: descriptionOf(provider, model),
    }];
  });
  if (configured.length) return configured;

  const usable = providers.filter((provider) => provider.id !== OPENCODE_PROVIDER && connected.has(provider.id));
  const requested = env.JEV_OPENCODE_PROVIDER;
  const provider = usable.find((item) => item.id === requested) ??
    PROVIDER_PRIORITY.map((id) => usable.find((item) => item.id === id)).find(Boolean) ??
    usable[0];
  if (!provider) return [];

  const candidates = Object.entries(provider.models ?? {}).flatMap(([key, model]) => {
    if (model.tool_call === false || model.status === "deprecated") return [];
    const modelID = model.id ?? key;
    const tier = opencodeTierOf(modelID);
    if (!tier || !availableTiers().includes(tier)) return [];
    return [{
      id: `${provider.id}/${modelID}`,
      providerID: provider.id,
      modelID,
      tier,
      description: descriptionOf(provider, model),
      released: model.release_date ?? "",
    }];
  });

  // Keep the choice prompt bounded for providers with very large catalogs while retaining
  // exact model versions as distinct choices, like the Claude and Codex integrations do.
  return availableTiers().flatMap((tier) =>
    candidates
      .filter((model) => model.tier === tier)
      .sort(compareCandidates)
      .slice(0, 4),
  );
}

/** Models returned by OpenCode v2's active model registry. */
export function opencodeV2Models(list, env = process.env) {
  const models = Array.isArray(list) ? list : [];
  const configured = Object.entries(MODEL_ENV).flatMap(([tier, name]) => {
    const parsed = splitModel(env[name]);
    if (!parsed || (tier === "fable" && !availableTiers().includes("fable"))) return [];
    const model = models.find((item) => item.providerID === parsed.providerID && item.id === parsed.modelID);
    if (!model) return [];
    return [{
      id: `${model.providerID}/${model.id}`,
      providerID: model.providerID,
      modelID: model.id,
      tier,
      description: [model.name, model.limit?.context && `${model.limit.context} context tokens`].filter(Boolean).join("; "),
    }];
  });
  if (configured.length) return configured;

  const usable = models.filter((model) =>
    model.providerID !== OPENCODE_PROVIDER &&
    model.enabled !== false &&
    model.capabilities?.tools !== false &&
    opencodeTierOf(model.id),
  );
  const providers = [...new Set(usable.map((model) => model.providerID))];
  const requested = env.JEV_OPENCODE_PROVIDER;
  const providerID = providers.includes(requested) ? requested :
    PROVIDER_PRIORITY.find((id) => providers.includes(id)) ?? providers[0];
  if (!providerID) return [];

  const candidates = usable.flatMap((model) => {
    if (model.providerID !== providerID) return [];
    const tier = opencodeTierOf(model.id);
    if (!tier || !availableTiers().includes(tier)) return [];
    return [{
      id: `${model.providerID}/${model.id}`,
      providerID: model.providerID,
      modelID: model.id,
      tier,
      description: [model.name, model.limit?.context && `${model.limit.context} context tokens`].filter(Boolean).join("; "),
      released: model.releaseDate ?? model.release_date ?? "",
    }];
  });
  return availableTiers().flatMap((tier) =>
    candidates
      .filter((model) => model.tier === tier)
      .sort(compareCandidates)
      .slice(0, 4),
  );
}

export function addOpenCodeProvider(config) {
  config.provider ??= {};
  config.provider[OPENCODE_PROVIDER] = {
    name: "Jev Router",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: "http://127.0.0.1:9/v1", apiKey: "unused" },
    models: {
      [OPENCODE_AUTO_MODEL]: {
        name: "Jev Router",
        tool_call: true,
        limit: { context: 200000, output: 100000 },
      },
    },
  };
  return config;
}

const textOf = (parts) => parts
  .filter((part) => part?.type === "text" && !part.synthetic && !part.ignored)
  .map((part) => part.text)
  .join("\n")
  .trim();

const unwrap = (result) => result?.data ?? result;

const sameOpenCodeModel = (model, selected) => model?.providerID === selected.providerID &&
  (model?.id ?? model?.modelID) === selected.modelID;

/**
 * OpenCode v2 projects model-selection events onto the session asynchronously. Waiting for that
 * projection keeps the runner from resolving the just-admitted prompt against the previous model.
 */
async function waitForOpenCodeModel(ctx, sessionID, selected) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const session = unwrap(await ctx.session.get({ sessionID }));
    if (sameOpenCodeModel(session?.model, selected)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `Jev Router selected ${selected.id}, but OpenCode did not activate it before prompt execution.`,
  );
}

async function chooseOpenCodeModel({ prompt, contextTokens, models, previous, route }) {
  const available = [...new Set(models.map((model) => model.tier))];
  const strongest = models.find((model) => model.tier === "opus") ??
    models.find((model) => model.tier === "sonnet") ?? models.at(-1);
  const currentModel = previous?.id ?? strongest.id;
  const current = previous?.tier ?? strongest.tier;
  
  const jev = await routeSafely(route, { prompt, current: currentModel, contextTokens, models });
  const chosen = models.find((model) => model.id === jev?.choice);
  const decision = decide({
    prompt,
    jev: jev && { ...jev, choice: chosen?.tier },
    current,
    available,
    contextTokens,
  });
  const selected = shouldUseExactModel(decision.reason, chosen?.tier, decision.tier)
    ? chosen
    : decision.tier === current
      ? (models.find((model) => model.id === currentModel) ?? strongest)
      : (models.find((model) => model.tier === decision.tier) ?? strongest);
  return { selected, jev, decision, taskType: jev?.taskType ?? null };
}

export function createOpenCodePlugin({ route = askJev } = {}) {
  return async ({ client }) => {
    const states = new Map();
    return {
      config: async (config) => void addOpenCodeProvider(config),
      "chat.message": async (input, output) => {
        if (output.message?.model?.providerID !== OPENCODE_PROVIDER ||
            output.message.model.modelID !== OPENCODE_AUTO_MODEL) return;

        const prompt = textOf(output.parts ?? []);
        if (!prompt) return;

        const listed = unwrap(await client.provider.list());
        const models = opencodeModels(listed);
        if (!models.length) {
          throw new Error(
            "Jev Router could not find a supported model in any connected OpenCode provider. " +
            "Connect Anthropic, OpenAI, GitHub Copilot, OpenCode, Google, or OpenRouter first.",
          );
        }

        let contextTokens = Math.round(prompt.length / 4);
        try {
          const history = unwrap(await client.session.messages({ path: { id: input.sessionID } })) ?? [];
          contextTokens += Math.round(JSON.stringify(history).length / 4);
        } catch {
          // Context size only guards costly downgrades; routing can proceed without it.
        }

        const previous = states.get(input.sessionID);
        const { selected, jev, decision, taskType } = await chooseOpenCodeModel({
          prompt, contextTokens, models, previous, route,
        });

        output.message.model = { providerID: selected.providerID, modelID: selected.modelID };
        states.set(input.sessionID, selected);
        writeDecision(`opencode-${input.sessionID}`, {
          prompt,
          taskType,
          tier: selected.tier,
          model: selected.id,
          confidence: jev?.confidence ?? null,
          metrics: jev?.metrics ?? null,
          reason: decision.reason,
          jev: jev ? { request: jev.request, response: jev.response } : null,
          at: Date.now(),
        });

        const detail = jev?.confidence == null
          ? decision.reason
          : `${decision.reason}, confidence ${jev.confidence.toFixed(2)}`;
        try {
          await client.tui?.showToast?.({
            body: {
              title: "Jev Router",
              message: `Routed this turn to ${selected.id} (${detail}).`,
              variant: "info",
              duration: 5000,
            },
          });
        } catch {
          // Headless `opencode run` has no TUI to notify.
        }
      },
    };
  };
}

/** OpenCode v2 setup hook. Prompt admission occurs before the session resolves its model. */
export function createOpenCodeV2Plugin({ route = askJev } = {}) {
  return async (ctx) => {
    const states = new Map();
    const registration = await ctx.session.hook("prompt", async (event) => {
      const session = unwrap(await ctx.session.get({ sessionID: event.sessionID }));
      const active = session?.model;
      const previous = states.get(event.sessionID);
      const isSentinel = active?.providerID === OPENCODE_PROVIDER &&
        (active?.id ?? active?.modelID) === OPENCODE_AUTO_MODEL;
      const isLastRouted = previous && active?.providerID === previous.providerID &&
        (active?.id ?? active?.modelID) === previous.modelID;
      if (!isSentinel && !isLastRouted) {
        states.delete(event.sessionID);
        return;
      }

      const prompt = String(event.prompt?.text ?? "").trim();
      if (!prompt) return;
      const models = opencodeV2Models(unwrap(await ctx.model.list()));
      if (!models.length) {
        throw new Error(
          "Jev Router could not find a supported model in any active OpenCode provider. " +
          "Connect Anthropic, OpenAI, GitHub Copilot, OpenCode, Google, or OpenRouter first.",
        );
      }

      let contextTokens = Math.round(prompt.length / 4);
      try {
        const history = unwrap(await ctx.session.context({ sessionID: event.sessionID })) ?? [];
        contextTokens += Math.round(JSON.stringify(history).length / 4);
      } catch {
        // Context size only guards costly downgrades; routing can proceed without it.
      }

      const { selected, jev, decision, taskType } = await chooseOpenCodeModel({
        prompt, contextTokens, models, previous, route,
      });
      await ctx.session.switchModel({
        sessionID: event.sessionID,
        model: { providerID: selected.providerID, id: selected.modelID },
      });
      await waitForOpenCodeModel(ctx, event.sessionID, selected);
      states.set(event.sessionID, selected);
      writeDecision(`opencode-${event.sessionID}`, {
        prompt,
        taskType,
        tier: selected.tier,
        model: selected.id,
        confidence: jev?.confidence ?? null,
        metrics: jev?.metrics ?? null,
        reason: decision.reason,
        jev: jev ? { request: jev.request, response: jev.response } : null,
        at: Date.now(),
      });
    });
    return () => registration.dispose();
  };
}

export default createOpenCodePlugin();
