import { existsSync, readFileSync } from "node:fs";

export interface Settings {
  bifrostUrl: string;
  virtualKey: string | null;
  virtualKeyId: string | null;
  adminUser: string | null;
  adminPassword: string | null;
  setupToken: string | null;
  primaryModel: string;
  fallbackModels: string[];
  tavilyKey: string | null;
  tavilyMaxCalls: number;
  tavilyLedger: string | null;
  today: string;
  requestTimeoutMs: number;
}

function env(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : null;
}

/** Reads the Tavily key from TAVILY_API_KEY, or from the file named by TAVILY_API_KEY_FILE. */
export function readTavilyKey(): string | null {
  const direct = env("TAVILY_API_KEY");
  if (direct) return direct;
  const file = env("TAVILY_API_KEY_FILE");
  if (file && existsSync(file)) {
    const v = readFileSync(file, "utf8").trim();
    return v === "" ? null : v;
  }
  return null;
}

export function loadSettings(): Settings {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const fallbacks = env("FRESHNESS_FALLBACK_MODELS") ?? "ollama/gemma4:e4b-it-q4km-chat";
  return {
    bifrostUrl: (env("BIFROST_URL") ?? "http://localhost:8080").replace(/\/+$/, ""),
    virtualKey: env("FRESHNESS_VK"),
    virtualKeyId: env("FRESHNESS_VK_ID") ?? "vk-freshness-auditor",
    adminUser: env("BIFROST_ADMIN_USERNAME"),
    adminPassword: env("BIFROST_ADMIN_PASSWORD"),
    setupToken: env("BIFROST_SETUP_TOKEN"),
    primaryModel: env("FRESHNESS_PRIMARY_MODEL") ?? "ollama/gemma4:26b-a4b-chat",
    fallbackModels: fallbacks.split(",").map((s) => s.trim()).filter(Boolean),
    tavilyKey: readTavilyKey(),
    tavilyMaxCalls: Number(env("TAVILY_MAX_CALLS") ?? "40"),
    tavilyLedger: env("TAVILY_LEDGER") ?? ".tavily-usage.json",
    // Local calendar date (sv-SE formats as YYYY-MM-DD); UTC would lag a day east of Greenwich.
    today: env("FRESHNESS_TODAY") ?? new Date().toLocaleDateString("sv-SE"),
    requestTimeoutMs: Number(env("FRESHNESS_TIMEOUT_MS") ?? "600000"),
  };
}
