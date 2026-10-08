import { detectTaskType, detectTaskTypeOverride, TASK_TYPES } from "../src/config.mjs";

/**
 * Test task type detection for Jev Router multi-task redesign
 */

const tests = [
  // Auto-detection tests
  {
    name: "Coding - debug keyword",
    prompt: "Help me debug why this test is failing",
    expectedTaskType: "coding",
    expectOverride: null,
  },
  {
    name: "Coding - implement keyword",
    prompt: "Implement this function according to the spec",
    expectedTaskType: "coding",
    expectOverride: null,
  },
  {
    name: "PSH - spec keyword",
    prompt: "Let's brainstorm features for the spec",
    expectedTaskType: "psh",
    expectOverride: null,
  },
  {
    name: "PSH - prd keyword",
    prompt: "Help me draft the PRD for this feature",
    expectedTaskType: "psh",
    expectOverride: null,
  },
  {
    name: "PSH - benchmark keyword",
    prompt: "Run a competitive benchmark analysis",
    expectedTaskType: "psh",
    expectOverride: null,
  },
  {
    name: "PDH - architecture keyword",
    prompt: "Design the system architecture for this feature",
    expectedTaskType: "pdh",
    expectOverride: null,
  },
  {
    name: "PDH - epic keyword",
    prompt: "Decompose this epic into tasks",
    expectedTaskType: "pdh",
    expectOverride: null,
  },
  {
    name: "Research - competitive keyword",
    prompt: "What are the top competitive solutions in this space?",
    expectedTaskType: "research",
    expectOverride: null,
  },
  {
    name: "Research - analyze keyword",
    prompt: "Analyze the current market trends",
    expectedTaskType: "research",
    expectOverride: null,
  },
  {
    name: "Documentation - write keyword",
    prompt: "Help me write API documentation",
    expectedTaskType: "documentation",
    expectOverride: null,
  },
  {
    name: "Documentation - guide keyword",
    prompt: "Create a user guide for this feature",
    expectedTaskType: "documentation",
    expectOverride: null,
  },
  {
    name: "Process - harness keyword",
    prompt: "Improve the harness setup process",
    expectedTaskType: "process",
    expectOverride: null,
  },
  {
    name: "Process - skill keyword",
    prompt: "Help me create a new skill",
    expectedTaskType: "process",
    expectOverride: null,
  },

  // Explicit override tests
  {
    name: "Override - use psh",
    prompt: "Use psh for this work",
    expectedTaskType: "psh",
    expectOverride: "psh",
  },
  {
    name: "Override - switch to pdh",
    prompt: "Switch to pdh",
    expectedTaskType: "pdh",
    expectOverride: "pdh",
  },
  {
    name: "Override - with research",
    prompt: "With research mode, analyze this",
    expectedTaskType: "research",
    expectOverride: "research",
  },
  {
    name: "Override - on documentation",
    prompt: "On documentation task - write this guide",
    expectedTaskType: "documentation",
    expectOverride: "documentation",
  },

  // Edge cases
  {
    name: "Multiple keywords - ordered precedence",
    prompt: "Debug the code and write documentation",
    expectedTaskType: "documentation", // 'documentation' task type is checked before 'coding'
    expectOverride: null,
  },
  {
    name: "Empty prompt",
    prompt: "",
    expectedTaskType: "coding", // default
    expectOverride: null,
  },
  {
    name: "No matching keywords",
    prompt: "Please help with this thing",
    expectedTaskType: "coding", // default
    expectOverride: null,
  },
];

function runTests() {
  let passed = 0;
  let failed = 0;

  console.log("🧪 Jev Router Task Type Detection Tests\n");
  console.log("=".repeat(70));

  for (const test of tests) {
    const detected = detectTaskType(test.prompt);
    const override = detectTaskTypeOverride(test.prompt);

    const taskTypeMatch = detected === test.expectedTaskType;
    const overrideMatch = override === test.expectOverride;

    const status = taskTypeMatch && overrideMatch ? "✅ PASS" : "❌ FAIL";

    if (taskTypeMatch && overrideMatch) {
      passed++;
    } else {
      failed++;
    }

    console.log(`${status} | ${test.name}`);
    if (!taskTypeMatch) {
      console.log(`     Expected task type: ${test.expectedTaskType}, got: ${detected}`);
    }
    if (!overrideMatch) {
      console.log(`     Expected override: ${test.expectOverride}, got: ${override}`);
    }
    if (test.prompt) {
      console.log(`     Prompt: "${test.prompt.substring(0, 60)}${test.prompt.length > 60 ? "..." : ""}"`);
    }
  }

  console.log("=".repeat(70));
  console.log(
    `\n📊 Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`
  );

  if (failed === 0) {
    console.log("🎉 All tests passed!");
  }

  return failed === 0;
}

const success = runTests();
process.exit(success ? 0 : 1);
