import { createOpenCodePlugin, createOpenCodeV2Plugin } from "../src/opencode-plugin.mjs";

export default {
  id: "jev-router",
  setup: createOpenCodeV2Plugin(),
  server: createOpenCodePlugin(),
};
