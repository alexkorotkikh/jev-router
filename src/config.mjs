// Every routing decision knob lives here, so the whole policy is reviewable in one file.
import { choice, score } from "@typesafe-ai/sdk";

/**
 * Model tiers, cheapest first. `id` is what goes into the API request body; `family` is the
 * substring used to recognise whatever model Claude Code asked for, which may be an older
 * version within the same tier such as `claude-sonnet-4-6`. The capability flags come from
 * the Agent SDK's model catalogue: Haiku supports neither adaptive thinking nor effort, so
 * those fields have to be stripped when routing down to it.
 */
export const TIERS = [
  { name: "haiku", id: "claude-haiku-4-5-20251001", family: "haiku", thinking: false, effort: false },
  { name: "sonnet", id: "claude-sonnet-5", family: "sonnet", thinking: true, effort: true },
  { name: "opus", id: "claude-opus-5", family: "opus", thinking: true, effort: true },
  { name: "fable", id: "claude-fable-5-1", family: "fable", thinking: true, effort: true },
];

export const TIER_NAMES = TIERS.map((t) => t.name);

export const rankOf = (name) => TIER_NAMES.indexOf(name);

export const idOf = (name) => TIERS.find((t) => t.name === name)?.id;

export const tierSpec = (name) => TIERS.find((t) => t.name === name);

/**
 * Sentinel model id offered as an extra row in Claude Code's /model picker. Claude Code
 * sends it verbatim because it does not validate model names behind a custom base URL, so
 * its presence in a request is an exact signal that the user wants this turn routed. Any
 * other model means the user picked one themselves and it must be passed straight through.
 */
export const AUTO_MODEL = "jev-router";

/** Whether a request should be routed, or passed through as the user's own choice. */
export const isAuto = (model) => model === AUTO_MODEL;

/** Tier name for a model string Claude Code sent, or null if we don't recognise it. */
export const tierOf = (model) =>
  TIERS.find((t) => typeof model === "string" && model.includes(t.family))?.name ?? null;

/**
 * Fable bills extra usage credits, so it is opt-in. Everything else is covered by a normal
 * subscription.
 */
export const availableTiers = () =>
  TIER_NAMES.filter((n) => n !== "fable" || process.env.JEV_ALLOW_FABLE === "1");

export const THRESHOLDS = {
  /** Below this Jev confidence we refuse to downgrade and cap upgrades at `uncertainCeiling`. */
  minConfidence: 0.3,
  /** Safest tier to land on when Jev is unsure. */
  uncertainCeiling: "sonnet",
  /**
   * Switching models invalidates the prompt cache; the next turn re-sends the whole
   * conversation. Measured at ~23.6k cache-creation tokens switching into Opus, so a
   * downgrade only pays off while the conversation is still small.
   */
  downgradeMaxContextTokens: 20000,
  /**
   * Per-attempt Jev HTTP timeout and the hard wall-clock deadline for the whole routing
   * call. Measured: ~300-350ms warm, ~900-1000ms on the first call (TLS handshake), so the
   * deadline leaves room for one retry after a cold-start timeout.
   */
  jevTimeoutMs: 1500,
  jevDeadlineMs: 3000,
  jevMaxRetries: 1,
};

/**
 * Task types define different routing criteria for different kinds of work.
 * Each task type has its own questions and model guidance.
 * 
 * Keywords are checked in order to avoid false positives:
 * - Use specific keywords where possible
 * - More specific/longer keywords rank higher in detection
 * - Defaults to 'coding' if no matches
 */
export const TASK_TYPES = {
  psh: {
    name: "Product Specification Harness",
    description: "Feature brainstorming, benchmarking, scoping, PRD writing, design docs, prototyping, SDD, decomposition, handover",
    keywords: ["psh", "design doc", "design concept", "benchmark", "feature vision", "target release", "scope", "prd", "prototype", "sdd", "specification", "brainstorm"],
  },
  pdh: {
    name: "Product Development Harness",
    description: "Engineering intake, architecture, decomposition, build, release, learn phases",
    keywords: ["pdh", "intake", "architecture", "epic", "release gate", "learn phase"],
  },
  research: {
    name: "Research & Analysis",
    description: "Deep research, competitive analysis, trend analysis, literature review, synthesis",
    keywords: ["research", "competitive analysis", "trend analysis", "competitive", "analyze", "compare", "survey", "study", "literature review", "synthesis", "investigate"],
  },
  documentation: {
    name: "Documentation & Writing",
    description: "Technical writing, design docs, API docs, guide writing, content creation",
    keywords: ["documentation", "api doc", "api documentation", "readme", "guide", "tutorial", "write"],
  },
  process: {
    name: "Process & Tooling",
    description: "Harness maintenance, skill creation, context fixes, environment setup, troubleshooting",
    keywords: ["skill creation", "skill", "context fix", "harness", "setup", "troubleshoot", "tool"],
  },
  coding: {
    name: "Coding",
    description: "Implementation, debugging, refactoring, testing, code review",
    keywords: ["code", "implement", "debug", "test", "refactor", "fix", "lint", "build", "deploy", "script"],
  },
};

export const TASK_TYPE_KEYS = Object.keys(TASK_TYPES);

export const CONTEXT_WINDOW_TOKENS = 200000;

const COMPLEXITY_SCALE = [
  "None",
  "Very low",
  "Low",
  "Some",
  "Moderate",
  "Moderate to high",
  "High",
  "Very high",
  "Severe",
  "Extreme",
];

export const COMPLEXITY_MAX_SCORE = COMPLEXITY_SCALE.length - 1;

/** Phrases that mean "the human already decided", checked against the raw prompt. */
export const OVERRIDE_PATTERNS = TIERS.map((t) => ({
  tier: t.name,
  re: new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${{
      haiku: "haiku|fast|luna",
      sonnet: "sonnet|balanced|terra",
      opus: "opus|strong|sol",
      fable: "fable|long|astra",
    }[t.name]})\\b`,
    "i",
  ),
}));

/**
 * Generic questions shared across all task types.
 * Each task type may add task-specific questions via getTaskTypeQuestions().
 */
export const CORE_QUESTIONS = {
  reasoning_required: score(
    "How much reasoning is required to complete the request correctly in one pass?",
    COMPLEXITY_SCALE,
  ),
};

/**
 * Task-type-specific questions and model guidance.
 */
const TASK_TYPE_CONFIG = {
  coding: {
    questions: {
      task_complexity: score(
        "How complex is the coding task overall, including ambiguity, scope, and blast radius?",
        COMPLEXITY_SCALE,
      ),
      tool_complexity: score(
        "How complex is the tool use required, from no tools to many coordinated or stateful operations?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Trivial, mechanical, or purely factual work.",
        signals: ["Rename, reformat, comment, or run one obvious command"],
        not_for: "Design judgement or multi-file reasoning.",
      },
      sonnet: {
        what: "Ordinary day-to-day engineering with a clear, bounded shape.",
        signals: ["Implement a specified function, test existing behaviour, or fix an understood local bug"],
        not_for: "Open-ended architecture, subtle concurrency, or unknown-cause debugging.",
      },
      opus: {
        what: "Hard reasoning, ambiguity, or high blast radius.",
        signals: ["Unknown-cause debugging, cross-module design, security, auth, concurrency, or migrations"],
        not_for: "Routine work with a clear implementation.",
      },
      fable: {
        what: "Very large or long-running work beyond a normal focused session.",
        signals: ["Whole-repo migration, unusually large context, or multi-hour autonomous execution"],
        not_for: "Anything a strong model can finish in one focused session.",
      },
    },
  },
  psh: {
    questions: {
      depth_of_analysis: score(
        "How deep is the required analysis? From simple brainstorming to rigorous competitive research, scoping, and strategic vision?",
        COMPLEXITY_SCALE,
      ),
      stakeholder_complexity: score(
        "How many stakeholders, viewpoints, or dependencies must be balanced?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Simple brainstorming prompts or transcription of existing materials.",
        signals: ["Braindump session note-taking, light brainstorm organization"],
        not_for: "Competitive research, strategic vision, scoping decisions.",
      },
      sonnet: {
        what: "Clear feature work within bounded scope, including PRD drafting and design doc writing.",
        signals: ["Draft PRD for a well-defined feature, write design concepts, organize research"],
        not_for: "Deep competitive benchmarks, cross-product vision, complex stakeholder negotiations.",
      },
      opus: {
        what: "Strategic work, deep research, complex scoping, cross-cutting vision.",
        signals: ["Four-lens competitive benchmark, feature vision synthesis, Target Release scoping with tradeoffs"],
        not_for: "Straightforward feature documentation or simple prototyping.",
      },
      fable: {
        what: "Very large feature ecosystems or comprehensive market research beyond a single session.",
        signals: ["Multi-week research synthesis, whole-product strategic repositioning"],
        not_for: "Any task completable in one focused thinking session.",
      },
    },
  },
  pdh: {
    questions: {
      architecture_complexity: score(
        "How complex is the architectural challenge? From straightforward to novel, multi-system, or high-risk designs?",
        COMPLEXITY_SCALE,
      ),
      cross_team_coordination: score(
        "How much cross-team coordination, API contracts, or integration complexity is required?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Straightforward implementation of clear specs, mechanical build tasks.",
        signals: ["Implement a specified function, write a test, format code"],
        not_for: "Architecture decisions, complex debugging, cross-system design.",
      },
      sonnet: {
        what: "Ordinary engineering work with clear specs and bounded scope.",
        signals: ["Implement a well-defined feature, fix a known bug, write tests, standard decomposition"],
        not_for: "Unknown-cause debugging, novel architecture, security decisions.",
      },
      opus: {
        what: "Hard engineering challenges: novel architecture, security, concurrency, unknown bugs, cross-system design.",
        signals: ["SDD for complex system, debug obscure failures, security modeling, cross-team API design"],
        not_for: "Routine implementation of clear specs.",
      },
      fable: {
        what: "Massive refactors, whole-system migrations, or very large feature sets.",
        signals: ["Multi-epic migration, architectural rework across all services"],
        not_for: "Work completable in one focused engineering session.",
      },
    },
  },
  research: {
    questions: {
      research_scope: score(
        "How broad and deep is the research scope? From simple lookup to comprehensive multi-source synthesis?",
        COMPLEXITY_SCALE,
      ),
      synthesis_complexity: score(
        "How complex is the synthesis and analysis required? From aggregation to novel insights and comparisons?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Simple factual lookups or well-known information aggregation.",
        signals: ["What is X?", "List the top 5 tools for Y", "Current pricing of Z"],
        not_for: "Deep comparative analysis, trend analysis, novel synthesis.",
      },
      sonnet: {
        what: "Clear research tasks with structured output and moderate analysis.",
        signals: ["Compare two tools/services", "Summarize market segment", "Review existing studies"],
        not_for: "Comprehensive multi-source benchmarks, trends, novel insights.",
      },
      opus: {
        what: "Complex, multi-source research with novel synthesis and insights.",
        signals: ["Four-lens competitive benchmark", "Deep trend analysis", "Cross-industry synthesis", "Strategic insights"],
        not_for: "Simple factual lookup or straightforward comparison.",
      },
      fable: {
        what: "Exhaustive research across many sources or very long-form synthesis.",
        signals: ["Full market survey", "Comprehensive literature review", "Multi-week research project"],
        not_for: "Anything finishable in one focused research session.",
      },
    },
  },
  documentation: {
    questions: {
      content_complexity: score(
        "How complex is the content? From simple writing to intricate technical concepts and edge cases?",
        COMPLEXITY_SCALE,
      ),
      audience_breadth: score(
        "How broad and diverse is the target audience? From specialists to general users?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Simple, straightforward documentation or light editing.",
        signals: ["Format existing content", "Simple feature guide", "Basic API doc entry"],
        not_for: "Complex technical writing, multi-audience docs, strategic messaging.",
      },
      sonnet: {
        what: "Clear technical writing and documentation for knowledgeable audiences.",
        signals: ["Write a technical guide", "Draft API documentation", "Create a tutorial", "Edit and improve docs"],
        not_for: "Complex multi-audience messaging, strategic positioning docs, intricate concepts.",
      },
      opus: {
        what: "Complex technical writing, strategic messaging, and multi-audience documentation.",
        signals: ["Design docs for complex systems", "Strategic positioning messaging", "Multi-audience guide", "Novel concept explanation"],
        not_for: "Simple feature guides or straightforward technical writing.",
      },
      fable: {
        what: "Comprehensive documentation suites or very large strategic writing projects.",
        signals: ["Full product documentation", "Complete guide suite", "Large strategic positioning effort"],
        not_for: "Single documents or individual guides.",
      },
    },
  },
  process: {
    questions: {
      system_complexity: score(
        "How complex is the system or process? From simple configuration to intricate harness mechanics?",
        COMPLEXITY_SCALE,
      ),
      debugging_difficulty: score(
        "How difficult is the debugging or troubleshooting? From obvious to subtle or multi-layered?",
        COMPLEXITY_SCALE,
      ),
    },
    guidance: {
      haiku: {
        what: "Simple process improvements, basic configuration, straightforward setup.",
        signals: ["File an improvement request", "Simple environment setup", "Basic troubleshooting step"],
        not_for: "Complex harness mechanics, multi-system debugging, architecture decisions.",
      },
      sonnet: {
        what: "Ordinary process/tooling work, clear improvements, skill creation.",
        signals: ["Create a new skill", "Improve a process step", "Setup a workflow", "Simple skill optimization"],
        not_for: "Complex harness mechanics, cross-system context fixes, architectural changes.",
      },
      opus: {
        what: "Complex process work, harness mechanics, context fixes, subtle improvements.",
        signals: ["Context fix with multiple layers", "Skill optimization with evals", "Harness architecture work", "Cross-system improvements"],
        not_for: "Simple, straightforward process improvements.",
      },
      fable: {
        what: "Major harness refactors or very large-scale process reorganizations.",
        signals: ["Rewrite core harness module", "Major skill redesign", "Comprehensive context reorganization"],
        not_for: "Ordinary process improvements.",
      },
    },
  },
};

export const getTaskTypeConfig = (taskType) => TASK_TYPE_CONFIG[taskType] || TASK_TYPE_CONFIG.coding;

/**
 * Detect task type from prompt text using keyword matching.
 * Checks task types in order of definition (most specific first: psh, pdh, research, doc, process).
 * Returns the first task type with keyword matches, defaulting to 'coding'.
 * 
 * This ordering ensures that more specific keywords are checked before generic ones.
 */
export function detectTaskType(prompt) {
  if (!prompt) return "coding";
  
  const lowerPrompt = prompt.toLowerCase();
  const ordered = [
    ["psh", TASK_TYPES.psh],
    ["pdh", TASK_TYPES.pdh],
    ["research", TASK_TYPES.research],
    ["documentation", TASK_TYPES.documentation],
    ["process", TASK_TYPES.process],
    ["coding", TASK_TYPES.coding],
  ];
  
  for (const [key, config] of ordered) {
    for (const keyword of config.keywords) {
      // Escape special regex chars and create flexible matching for phrases
      const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = escaped.replace(/\s+/g, "\\s+");
      const regex = new RegExp(`\\b${pattern}\\b`, "i");
      if (regex.test(lowerPrompt)) {
        return key;
      }
    }
  }
  
  return "coding"; // default
}

/**
 * Detect explicit task-type override in prompt.
 * Users can say "use psh" or "switch to pdh" to force a specific task type.
 */
export function detectTaskTypeOverride(prompt) {
  if (!prompt) return null;
  
  const taskTypeOverridePattern = new RegExp(
    `\\b(?:use|switch to|with|on)\\s+(?:${TASK_TYPE_KEYS.join("|")})\\b`,
    "i"
  );
  
  const match = prompt.match(taskTypeOverridePattern);
  if (!match) return null;
  
  const matched = match[0].toLowerCase();
  for (const key of TASK_TYPE_KEYS) {
    if (matched.includes(key)) return key;
  }
  
  return null;
}

/** Explicit task-type override first, then keyword detection. */
export const resolveTaskType = (prompt) => detectTaskTypeOverride(prompt) ?? detectTaskType(prompt);

/** Scored questions Jev answers for one task type: the shared core plus the type's own. */
export const questionsFor = (taskType) => ({ ...CORE_QUESTIONS, ...getTaskTypeConfig(taskType).questions });

/** The coding question set, the router's original and default behaviour. */
export const QUESTIONS = questionsFor("coding");

/** Build a Jev choice from the exact models available to this account and CLI. */
export const questionForModels = (models, taskType = "coding") => {
  const { guidance } = getTaskTypeConfig(taskType);
  const kind = taskType === "coding" ? "coding" : TASK_TYPES[taskType]?.name ?? "coding";
  return choice(
    [
      `Pick the cheapest exact model that can fully complete this ${kind} request in one pass, without retrying on a stronger model.`,
      "Treat different model versions as separate choices. Judge required reasoning, not requested reply length.",
    ],
    Object.fromEntries(
      models.map(({ id, tier, description }) => [
        id,
        { model: description ?? id, ...guidance[tier] },
      ]),
    ),
  );
};

/** Whether policy accepted Jev's exact model, including a version change within one tier. */
export const shouldUseExactModel = (reason, chosenTier, finalTier) =>
  (reason === "jev" || reason === "jev/no-change") && chosenTier === finalTier;
