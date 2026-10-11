// Manual check against the live routing backend: node test/live-routing.mjs [--router openai]
// (needs JEV_API_KEY, or OPENAI_API_KEY with --router openai).
// Prints the detected task type, Jev's choice and the tier we would expect, so prompt and
// guidance changes can be judged on real answers. Not part of `npm test`.
const { homedir } = await import("node:os");
for (const file of [".env", `${homedir()}/.jev-router.env`]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Missing; the key may still come from the real environment.
  }
}
const { askRouter, routerName, takeRouterFlags } = await import("../src/router.mjs");
takeRouterFlags(process.argv.slice(2));
console.log(`router: ${routerName()}${routerName() === "openai" ? ` (${process.env.JEV_OPENAI_MODEL || "gpt-5-mini"})` : ""}\n`);
const { TIERS } = await import("../src/config.mjs");

const models = TIERS.map(({ id, name }) => ({ id, tier: name }));
const tierOf = (id) => models.find((model) => model.id === id)?.tier ?? id;

// [prompt, expected tier]
const cases = [
  ["fix the typo 'recieve' in README.md", "haiku"],
  ["add a unit test for the existing formatDate helper", "sonnet"],
  ["users intermittently get logged out after deploy, figure out why", "opus"],
  ["migrate the entire monorepo from webpack to vite", "fable"],
  ["brainstorm features for the new spec, just a braindump for now", "haiku"],
  ["draft the PRD for slice 2 from the approved scope", "sonnet"],
  ["run the four-lens competitive benchmark and synthesise the feature vision", "opus"],
  ["decompose this epic into tasks following the SDD", "sonnet"],
  ["design the architecture for cross-team event sourcing with an auth migration", "opus"],
  ["what is the current pricing of Linear's business plan", "haiku"],
  ["compare Notion and Confluence for our team wiki", "sonnet"],
  ["write a short README section on installing the CLI", "sonnet"],
  ["create a new skill that files improvement requests", "sonnet"],
];

let matches = 0;
for (const [prompt, expected] of cases) {
  const a = await askRouter({ prompt, current: models.find((m) => m.tier === "sonnet").id, contextTokens: 0, models });
  if (!a) {
    console.log(`FAIL  ${prompt}`);
    continue;
  }
  const tier = tierOf(a.choice);
  if (tier === expected) matches++;
  const mark = tier === expected ? "ok  " : "DIFF";
  console.log(
    `${mark} ${a.taskType.padEnd(13)} ${tier.padEnd(6)} (expected ${expected.padEnd(6)}) ` +
      `conf=${a.confidence.toFixed(2)} ${String(a.ms).padStart(5)}ms | ${prompt}`,
  );
}
console.log(`\n${matches}/${cases.length} matched the expected tier`);
