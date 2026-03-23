// src/config.ts
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { Agent } from "undici";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { AppConfig, ProviderConfig, RoutingEntry, ServerConfig } from "./types.js";

// --- Zod schemas for raw (pre-resolution) config ---

const modelLimitsSchema = z.object({
  maxOutputTokens: z.number().int().positive(),
}).optional();

const providerSchema = z.object({
  baseUrl: z.string().url().refine(
    (url) => /^https?:\/\//.test(url),
    "baseUrl must use http:// or https://"
  ),
  apiKey: z.string().min(1, "apiKey is required"),
  timeout: z.number().default(30000),
  ttfbTimeout: z.number().default(15000),
  stallTimeout: z.number().default(30000),
  authType: z.enum(["anthropic", "bearer"]).default("anthropic"),
  modelLimits: modelLimitsSchema,
  concurrentLimit: z.number().int().min(1).optional(),
  poolSize: z.number().int().min(1).max(100).optional(),
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().min(1).optional(),
    cooldownSeconds: z.number().int().min(1).optional(),
  }).optional(),
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
    .default({ port: 3456, host: "localhost" }),
  providers: z.record(z.string(), providerSchema),
  routing: z.record(z.string(), z.array(routingEntrySchema)).default({}),
  tierPatterns: z.record(z.string(), z.array(z.string())).default({}),
  modelRouting: z.record(z.string(), z.array(routingEntrySchema)).default({}),
});

// --- Env var resolution ---

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, varName) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
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

export function findConfigFile(cwd: string = process.cwd(), { skipGlobal = false } = {}): string | null {
  const localPath = join(cwd, "modelweaver.yaml");
  if (existsSync(localPath)) return localPath;
  if (!skipGlobal) {
    const globalPath = join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".modelweaver",
      "config.yaml"
    );
    if (existsSync(globalPath)) return globalPath;
  }
  return null;
}

// --- Lightweight peek (no env resolution, no Zod validation) ---

/** Peek at existing config to extract provider metadata without resolving env vars or validating.
 *  Used by init wizard to show existing providers and offer add/edit. */
export function peekConfig(
  cwd?: string,
): { configPath: string; providers: Map<string, { baseUrl: string; envKey: string; authType: "anthropic" | "bearer"; timeout: number }>; server: { port: number; host: string } | null; modelRouting: Map<string, { provider: string; model: string }[]> } | null {
  const configPath = findConfigFile(cwd);
  if (!configPath) return null;

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  const providersRaw = (parsed?.providers ?? {}) as Record<string, Record<string, unknown>>;

  const providers = new Map<string, { baseUrl: string; envKey: string; authType: "anthropic" | "bearer"; timeout: number }>();

  for (const [id, config] of Object.entries(providersRaw)) {
    const apiKey = String(config.apiKey ?? "");
    const envMatch = apiKey.match(/^\$\{([^}]+)\}$/);
    const envKey = envMatch ? envMatch[1] : "";

    providers.set(id, {
      baseUrl: String(config.baseUrl ?? ""),
      envKey,
      authType: String(config.authType ?? "anthropic") as "anthropic" | "bearer",
      timeout: Number(config.timeout ?? 30000),
    });
  }

  const serverRaw = parsed?.server as Record<string, unknown> | undefined;
  const server = serverRaw ? {
    port: Number(serverRaw.port ?? 3456),
    host: String(serverRaw.host ?? "localhost"),
  } : null;

  // Parse modelRouting (alias -> provider chain)
  const modelRouting = new Map<string, { provider: string; model: string }[]>();
  const modelRoutingRaw = (parsed?.modelRouting ?? {}) as Record<string, { provider: string; model: string }[]>;
  for (const [alias, entries] of Object.entries(modelRoutingRaw)) {
    if (Array.isArray(entries)) {
      modelRouting.set(alias, entries.map(e => ({ provider: String(e.provider ?? ""), model: String(e.model ?? alias) })));
    }
  }

  return { configPath, providers, server, modelRouting };
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
  const parsed = parseYaml(raw, { customTags: [] });

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

  // Cross-validate modelRouting provider references
  for (const [modelName, entries] of Object.entries(validated.modelRouting)) {
    for (const entry of entries) {
      if (!providerNames.has(entry.provider)) {
        throw new Error(
          `modelRouting for model "${modelName}" references unknown provider "${entry.provider}". Available: ${[...providerNames].join(", ")}`
        );
      }
    }
  }

  // Build typed config — cache parsed URL components per provider (avoids per-request URL parsing)
  const providers = new Map<string, ProviderConfig>();
  for (const [name, p] of Object.entries(validated.providers)) {
    const providerConfig: ProviderConfig = {
      name,
      baseUrl: p.baseUrl,
      apiKey: p.apiKey,
      timeout: p.timeout,
      ttfbTimeout: p.ttfbTimeout,
      stallTimeout: p.stallTimeout,
      authType: p.authType,
      modelLimits: p.modelLimits ? { maxOutputTokens: p.modelLimits.maxOutputTokens } : undefined,
      concurrentLimit: p.concurrentLimit,
    };
    try {
      const parsedUrl = new URL(p.baseUrl);
      providerConfig._cachedHost = parsedUrl.host;
      providerConfig._cachedOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
      providerConfig._cachedPathname = parsedUrl.pathname.replace(/\/+$/, "");
    } catch {
      // If baseUrl is invalid, skip caching — buildOutboundHeaders will fall back gracefully
    }
    // Create per-provider connection pool for HTTP keep-alive reuse
    const poolSize = (p as Record<string, unknown>).poolSize as number | undefined;
    providerConfig._agent = new Agent({
      keepAliveTimeout: 30000,
      keepAliveMaxTimeout: 60000,
      connections: poolSize ?? 10,
      allowH2: true,
    });
    providerConfig.poolSize = poolSize ?? 10;
    // Create per-provider circuit breaker
    const cbConfig = (p as Record<string, unknown>).circuitBreaker as Record<string, number> | undefined;
    providerConfig._circuitBreaker = new CircuitBreaker(cbConfig ? {
      failureThreshold: cbConfig.failureThreshold,
      windowSeconds: cbConfig.windowSeconds,
      cooldownSeconds: cbConfig.cooldownSeconds,
    } : undefined);
    providers.set(name, providerConfig);
  }

  const routing = new Map<string, RoutingEntry[]>();
  for (const [tier, entries] of Object.entries(validated.routing)) {
    routing.set(tier, entries);
  }

  const tierPatterns = new Map<string, string[]>();
  for (const [tier, patterns] of Object.entries(validated.tierPatterns)) {
    tierPatterns.set(tier, patterns);
  }

  const modelRouting = new Map<string, RoutingEntry[]>();
  if (validated.modelRouting) {
    for (const [model, entries] of Object.entries(validated.modelRouting)) {
      modelRouting.set(model, entries);
    }
  }

  const server: ServerConfig = {
    port: validated.server.port,
    host: validated.server.host,
  };

  const config: AppConfig = { server, providers, routing, tierPatterns, modelRouting };
  return { config, configPath: path };
}

// --- Reload helper ---

export function reloadConfig(configPath: string): AppConfig {
  const { config } = loadConfig(configPath);
  return config;
}
