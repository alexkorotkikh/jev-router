import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./codex-cli.mjs";
import { addOpenCodeProvider } from "./opencode-plugin.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_URL = pathToFileURL(join(ROOT, "opencode-plugin")).href;

export function resolveOpenCode() {
  const win = process.platform === "win32";
  const exts = win ? [".exe", ".ps1", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(win ? ";" : ":")) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir.replace(/^"|"$/g, ""), `opencode${ext}`);
      try {
        accessSync(file, constants.F_OK);
        if (/\.ps1$/i.test(file)) {
          return { file: "powershell.exe", prefix: ["-NoProfile", "-File", file], shell: false };
        }
        return { file, prefix: [], shell: /\.(cmd|bat)$/i.test(file) };
      } catch {
        // Not here; keep looking.
      }
    }
  }
  return null;
}

export function opencodeConfig(content = "", pluginURL = PLUGIN_URL) {
  let config = {};
  if (content) {
    try {
      config = JSON.parse(content);
    } catch {
      // OpenCode will still load its normal config files; only ignore malformed overlay JSON.
    }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return JSON.stringify(addOpenCodeProvider({
    ...config,
    model: "jev/auto",
    plugin: plugins.includes(pluginURL) ? plugins : [...plugins, pluginURL],
  }));
}

const SUBCOMMANDS = new Set([
  "upgrade", "update", "uninstall", "acp", "api", "debug", "auth", "mcp", "plugin",
  "models", "stats", "mini", "run", "session", "service", "reload", "pair", "serve",
]);

export function opencodeArgs(args) {
  if (args.includes("--standalone") || args.includes("--server")) return args;
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-v" || arg === "--completions")) {
    return args;
  }
  const routedAt = args.findIndex((arg) => arg === "run" || arg === "mini");
  if (routedAt >= 0) {
    return [...args.slice(0, routedAt + 1), "--standalone", ...args.slice(routedAt + 1)];
  }
  if (args.some((arg) => SUBCOMMANDS.has(arg))) return args;
  return ["--standalone", ...args];
}

export async function runOpenCode() {
  loadEnv();
  const command = resolveOpenCode();
  if (!command) {
    process.stderr.write(
      "[jev] OpenCode is not installed, or `opencode` is not on your PATH.\n" +
      "[jev] jev-opencode runs the real OpenCode CLI; install it first:\n" +
      "[jev]   https://opencode.ai/docs/\n",
    );
    process.exitCode = 1;
    return;
  }

  let args = process.argv.slice(2);
  const env = { ...process.env };
  if (env.JEV_API_KEY || env.TYPESAFE_API_KEY) {
    if (args.includes("--server")) {
      process.stderr.write(
        "[jev] --server uses a remote OpenCode service, so local Jev routing is unavailable; " +
        "starting OpenCode without routing.\n",
      );
    } else {
      env.OPENCODE_CONFIG_CONTENT = opencodeConfig(env.OPENCODE_CONFIG_CONTENT);
      args = opencodeArgs(args);
    }
  } else {
    process.stderr.write(
      "[jev] no JEV_API_KEY found - starting OpenCode without routing\n" +
      `[jev] add JEV_API_KEY=... to ${join(homedir(), ".jev-router.env")} and restart jev-opencode\n`,
    );
  }

  const childArgs = [...command.prefix, ...args];
  const child = spawn(
    command.file,
    command.shell ? childArgs.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)) : childArgs,
    { stdio: "inherit", shell: command.shell, env },
  );
  child.on("error", (err) => {
    process.stderr.write(`[jev] could not start OpenCode: ${err.message}\n`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = signal ? 1 : (code ?? 0);
  });
}
