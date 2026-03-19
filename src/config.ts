// src/config.ts
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { AppConfig, ProviderConfig, RoutingEntry, ServerConfig } from "./types.js";

// --- Zod schemas for raw (pre-resolution) config ---

const providerSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1, "apiKey is required"),
  timeout: z.number().default(30000),
});

const routingEntrySchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
});

const rawConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(3456),
      host: z.string().default("localhost"),
    })
    .default({}),
  providers: z.record(z.string(), providerSchema),
  routing: z.record(z.string(), z.array(routingEntrySchema)),
  tierPatterns: z.record(z.string(), z.array(z.string())),
});

// --- Env var resolution ---

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined || envValue === "") {
      throw new Error(`Missing environment variable: ${varName}`);
    }
    return envValue;
  });
}

function resolveAllEnvStrings(obj: unknown): unknown {
  if (typeof obj === "string") return resolveEnvVars(obj);
  if (Array.isArray(obj)) return obj.map(resolveAllEnvStrings);
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = resolveAllEnvStrings(val);
    }
    return result;
  }
  return obj;
}

// --- Config file discovery ---

export function findConfigFile(cwd: string = process.cwd()): string | null {
  const localPath = join(cwd, "modelweaver.yaml");
  if (existsSync(localPath)) return localPath;
  const globalPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".modelweaver",
    "config.yaml"
  );
  if (existsSync(globalPath)) return globalPath;
  return null;
}

// --- Load & validate ---

export function loadConfig(configPath?: string, cwd?: string): { config: AppConfig; configPath: string } {
  let path: string | null = null;
  if (configPath) {
    // If configPath is a directory, search for config file within it
    if (existsSync(configPath)) {
      try {
        const stat = statSync(configPath);
        if (stat.isDirectory()) {
          path = findConfigFile(configPath);
        } else {
          path = configPath;
        }
      } catch {
        path = configPath;
      }
    } else {
      path = configPath;
    }
  }
  if (!path) {
    path = findConfigFile(cwd);
  }
  if (!path) {
    throw new Error(
      "No config file found. Create modelweaver.yaml in your project root or ~/.modelweaver/config.yaml"
    );
  }

  const raw = readFileSync(path, "utf-8");
  const parsed = parseYaml(raw);

  // Resolve ${VAR} references in all string values
  const resolved = resolveAllEnvStrings(parsed) as z.infer<typeof rawConfigSchema>;

  const validated = rawConfigSchema.parse(resolved);

  // Cross-validation
  const providerNames = new Set(Object.keys(validated.providers));

  for (const [tier, entries] of Object.entries(validated.routing)) {
    for (const entry of entries) {
      if (!providerNames.has(entry.provider)) {
        throw new Error(
          `Routing tier "${tier}" references unknown provider "${entry.provider}". Available: ${[...providerNames].join(", ")}`
        );
      }
    }

    if (!validated.tierPatterns[tier]) {
      throw new Error(
        `Routing tier "${tier}" has no entry in tierPatterns. Add patterns for this tier.`
      );
    }
  }

  // Build typed config
  const providers = new Map<string, ProviderConfig>();
  for (const [name, p] of Object.entries(validated.providers)) {
    providers.set(name, {
      name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      timeout: p.timeout,
    });
  }

  const routing = new Map<string, RoutingEntry[]>();
  for (const [tier, entries] of Object.entries(validated.routing)) {
    routing.set(tier, entries);
  }

  const tierPatterns = new Map<string, string[]>();
  for (const [tier, patterns] of Object.entries(validated.tierPatterns)) {
    tierPatterns.set(tier, patterns);
  }

  const server: ServerConfig = {
    port: validated.server.port,
    host: validated.server.host,
  };

  const config: AppConfig = { server, providers, routing, tierPatterns };
  return { config, configPath: path };
}
