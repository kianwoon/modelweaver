// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { readFile, stat, access } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { CircuitBreaker } from "./circuit-breaker.js";
import type { AppConfig, HedgingConfig, ProviderConfig, RoutingEntry, ServerConfig } from "./types.js";

// --- Structured config validation error ---

/** A single field-level validation issue produced by Zod. */
export interface ConfigFieldError {
  /** Dot-joined path into the config object, e.g. "modelRouting.glm-5.1.0.weight" */
  path: string;
  /** Human-readable description of what went wrong */
  message: string;
  /** The value Zod received (if available) */
  received?: string;
  /** The type Zod expected (if available) */
  expected?: string;
}

/**
 * Custom error class for config validation failures.
 * Carries structured field errors for machine consumption (GUI, API)
 * and a human-readable summary for logs/CLI.
 */
export class ConfigValidationError extends Error {
  public readonly fieldErrors: ConfigFieldError[];
  public readonly isValidationError = true;

  constructor(fieldErrors: ConfigFieldError[]) {
    const summary = fieldErrors.length === 1
      ? `Config validation failed: ${fieldErrors[0].message} (at ${fieldErrors[0].path})`
      : `Config validation failed — ${fieldErrors.length} error(s):\n${fieldErrors.map(e => `  - ${e.path}: ${e.message}`).join("\n")}`;
    super(summary);
    this.name = "ConfigValidationError";
    this.fieldErrors = fieldErrors;
  }
}

/**
 * Convert a raw ZodError into structured ConfigFieldError[].
 * Extracts expected/received types from Zod's error code and params.
 */
export function formatZodErrors(error: z.ZodError): ConfigFieldError[] {
  const fields: ConfigFieldError[] = [];

  for (const issue of error.issues) {
    // Zod v4 uses top-level keys on the issue object, not nested params
    const issueAny = issue as unknown as Record<string, unknown>;
    const pathStr = issue.path.map(String).join(".");
    const received = issueAny.received !== undefined ? String(issueAny.received) : undefined;

    let expected: string | undefined;
    let message = issue.message;

    switch (issue.code) {
      case "invalid_type":
        // Zod v4: expected is top-level (e.g. "number", "string")
        expected = issueAny.expected as string | undefined;
        message = `Expected ${expected ?? "a valid type"}, got ${received ?? "unknown type"}`;
        break;
      case "invalid_value": {
        // Zod v4: enum validation uses "invalid_value" with "values" array
        const values = (issueAny.values as string[] | undefined)?.join(", ");
        expected = values ?? issueAny.expected as string | undefined;
        message = expected
          ? `Invalid value "${received}". Allowed: ${expected}`
          : issue.message;
        break;
      }
      case "too_small": {
        const minimum = issueAny.minimum as number | undefined;
        expected = `number >= ${minimum ?? "?"}`;
        message = `Value ${received ?? "?"} is too small (minimum: ${minimum ?? "?"})`;
        break;
      }
      case "too_big": {
        const maximum = issueAny.maximum as number | undefined;
        expected = `number <= ${maximum ?? "?"}`;
        message = `Value ${received ?? "?"} is too large (maximum: ${maximum ?? "?"})`;
        break;
      }
      case "invalid_format": {
        // Zod v4: string format validation (e.g. "url", "email")
        const format = issueAny.format as string | undefined;
        if (format === "url") {
          message = `Invalid URL: "${received}"`;
          expected = "valid URL (http:// or https://)";
        } else {
          expected = format ? `valid ${format}` : undefined;
          message = issue.message;
        }
        break;
      }
      default:
        // Zod v4: may still emit codes like invalid_string for min/max length checks
        const validation = issueAny.validation as string | undefined;
        expected = validation ? `valid string (${validation})` : undefined;
        message = issue.message;
        break;
    }

    fields.push({
      path: pathStr,
      message,
      received,
      expected,
    });
  }

  return fields;
}

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
  timeout: z.number().positive().default(20000),
  ttfbTimeout: z.number().positive().default(8000),
  stallTimeout: z.number().positive().default(15000),
  authType: z.enum(["anthropic", "bearer"]).default("anthropic"),
  modelLimits: modelLimitsSchema,
  concurrentLimit: z.number().int().min(1).optional(),
  poolSize: z.number().int().min(1).max(100).optional(),
  modelPools: z.record(z.string(), z.number().int().min(1).max(50)).optional(),
  connectionRetries: z.number().int().min(0).max(10).optional(),
  staleAgentThresholdMs: z.number().int().positive().optional(),
  circuitBreaker: z.object({
    failureThreshold: z.number().int().min(1).optional(),
    threshold: z.number().int().min(1).optional(),
    windowSeconds: z.number().int().min(1).optional(),
    cooldownSeconds: z.number().int().min(1).optional(),
    cooldown: z.number().int().min(1).optional(),
  }).transform((cb) => ({
    failureThreshold: cb.failureThreshold ?? cb.threshold,
    windowSeconds: cb.windowSeconds,
    cooldownSeconds: cb.cooldownSeconds ?? cb.cooldown,
  })).optional(),
});

const routingEntrySchema = z.object({
  provider: z.string(),
  model: z.string().optional(),
  weight: z.number().min(0).optional(),
});

const hedgingSchema = z.object({
  /** Delay (ms) before starting backup providers in staggered race */
  speculativeDelay: z.number().int().positive().default(500),
  /** Coefficient of variation threshold — hedging activates when CV >= this */
  cvThreshold: z.number().min(0).max(10).default(0.5),
  /** Maximum number of hedged copies per request */
  maxHedge: z.number().int().min(1).max(10).default(4),
});

const rawConfigSchema = z.object({
  server: z
    .object({
      port: z.number().int().min(1).max(65535).default(3456),
      host: z.string().default("localhost"),
      streamBufferMs: z.number().min(0).optional(),
      streamBufferBytes: z.number().min(0).optional(),
      globalBackoffEnabled: z.boolean().default(true).optional(),
      unhealthyThreshold: z.number().min(0).max(1).default(0.5).optional(),
      maxBodySizeMB: z.number().min(1).max(100).default(10).optional(),
      sessionIdleTtlMs: z.number().int().min(60000).optional(),
      disableThinking: z.boolean().default(false).optional(),
    })
    .default({ port: 3456, host: "localhost" }),
  providers: z.record(z.string(), providerSchema),
  routing: z.record(z.string(), z.array(routingEntrySchema)).default({}),
  tierPatterns: z.record(z.string(), z.array(z.string())).default({}),
  modelRouting: z.record(z.string(), z.array(routingEntrySchema)).default({}),
  hedging: hedgingSchema.optional(),
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
): { configPath: string; providers: Map<string, { baseUrl: string; envKey: string; authType: "anthropic" | "bearer"; timeout: number; ttfbTimeout?: number; concurrentLimit?: number; stallTimeout?: number; poolSize?: number; connectionRetries?: number; circuitBreaker?: { threshold?: number; windowSeconds?: number; cooldown?: number } }>; server: { port: number; host: string } | null; modelRouting: Map<string, { provider: string; model: string; weight?: number }[]>; hedging?: { speculativeDelay: number; cvThreshold: number; maxHedge: number } } | null {
  const configPath = findConfigFile(cwd);
  if (!configPath) return null;

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown>;
  const providersRaw = (parsed?.providers ?? {}) as Record<string, Record<string, unknown>>;

  const providers = new Map<string, { baseUrl: string; envKey: string; authType: "anthropic" | "bearer"; timeout: number; ttfbTimeout?: number; concurrentLimit?: number; stallTimeout?: number; poolSize?: number; connectionRetries?: number; circuitBreaker?: { threshold?: number; windowSeconds?: number; cooldown?: number } }>();

  for (const [id, config] of Object.entries(providersRaw)) {
    const apiKey = String(config.apiKey ?? "");
    const envMatch = apiKey.match(/^\$\{([^}]+)\}$/);
    const envKey = envMatch ? envMatch[1] : "";

    // Extract circuitBreaker config if present
    const cbRaw = config.circuitBreaker as Record<string, unknown> | undefined;
    const circuitBreaker = cbRaw ? {
      threshold: cbRaw.failureThreshold !== undefined ? Number(cbRaw.failureThreshold) : cbRaw.threshold !== undefined ? Number(cbRaw.threshold) : undefined,
      windowSeconds: cbRaw.windowSeconds !== undefined ? Number(cbRaw.windowSeconds) : undefined,
      cooldown: cbRaw.cooldownSeconds !== undefined ? Number(cbRaw.cooldownSeconds) : cbRaw.cooldown !== undefined ? Number(cbRaw.cooldown) : undefined,
    } : undefined;

    providers.set(id, {
      baseUrl: String(config.baseUrl ?? ""),
      envKey,
      authType: String(config.authType ?? "anthropic") as "anthropic" | "bearer",
      timeout: Number(config.timeout ?? 30000),
      ttfbTimeout: config.ttfbTimeout !== undefined ? Number(config.ttfbTimeout) : undefined,
      concurrentLimit: config.concurrentLimit !== undefined ? Number(config.concurrentLimit) : undefined,
      stallTimeout: config.stallTimeout !== undefined ? Number(config.stallTimeout) : undefined,
      poolSize: config.poolSize !== undefined ? Number(config.poolSize) : undefined,
      connectionRetries: config.connectionRetries !== undefined ? Number(config.connectionRetries) : undefined,
      circuitBreaker,
    });
  }

  const serverRaw = parsed?.server as Record<string, unknown> | undefined;
  const server = serverRaw ? {
    port: Number(serverRaw.port ?? 3456),
    host: String(serverRaw.host ?? "localhost"),
  } : null;

  // Parse modelRouting (alias -> provider chain)
  const modelRouting = new Map<string, { provider: string; model: string; weight?: number }[]>();
  const modelRoutingRaw = (parsed?.modelRouting ?? {}) as Record<string, { provider: string; model: string; weight?: number }[]>;
  for (const [alias, entries] of Object.entries(modelRoutingRaw)) {
    if (Array.isArray(entries)) {
      modelRouting.set(alias, entries.map(e => ({
        provider: String(e.provider ?? ""),
        model: String(e.model ?? alias),
        weight: e.weight !== undefined ? Number(e.weight) : undefined,
      })));
    }
  }

  // Parse hedging config if present
  const hedgingRaw = parsed?.hedging as Record<string, unknown> | undefined;
  const hedging = hedgingRaw ? {
    speculativeDelay: Number(hedgingRaw.speculativeDelay ?? 500),
    cvThreshold: Number(hedgingRaw.cvThreshold ?? 0.5),
    maxHedge: Number(hedgingRaw.maxHedge ?? 4),
  } : undefined;

  return { configPath, providers, server, modelRouting, hedging };
}

// --- Project-level routing overlay ---

/**
 * Load modelRouting from a project-level config file (./modelweaver.yaml) without
 * full validation. Returns null if the file doesn't exist or has no modelRouting.
 * The project config may be routing-only (no providers) — only modelRouting matters.
 */
function loadProjectRoutingOverlay(cwd: string): Map<string, RoutingEntry[]> | null {
  const localPath = join(cwd, "modelweaver.yaml");
  if (!existsSync(localPath)) return null;

  try {
    const raw = readFileSync(localPath, "utf-8");
    const parsed = parseYaml(raw) as Record<string, unknown> | null;
    if (!parsed || !parsed.modelRouting) return null;

    const modelRoutingRaw = parsed.modelRouting as Record<string, unknown>;
    const overlay = new Map<string, RoutingEntry[]>();
    for (const [alias, rawEntries] of Object.entries(modelRoutingRaw)) {
      if (!Array.isArray(rawEntries)) continue;
      const validated = z.array(routingEntrySchema).safeParse(rawEntries);
      if (!validated.success) {
        console.warn(`Skipping invalid modelRouting "${alias}" in project config`);
        continue;
      }
      overlay.set(alias, validated.data);
    }
    return overlay.size > 0 ? overlay : null;
  } catch {
    return null;
  }
}

// --- Load & validate ---

export async function loadConfig(configPath?: string, cwd?: string): Promise<{ config: AppConfig; configPath: string }> {
  let path: string | null = null;
  if (configPath) {
    // If configPath is a directory, search for config file within it
    try {
      await access(configPath);
      const fileStat = await stat(configPath);
      if (fileStat.isDirectory()) {
        path = findConfigFile(configPath);
      } else {
        path = configPath;
      }
    } catch {
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

  const raw = await readFile(path, "utf-8");
  const parsed = parseYaml(raw, { customTags: [] });

  // Resolve ${VAR} references in all string values
  const resolved = resolveAllEnvStrings(parsed) as z.infer<typeof rawConfigSchema>;

  const parseResult = rawConfigSchema.safeParse(resolved);
  if (!parseResult.success) {
    throw new ConfigValidationError(formatZodErrors(parseResult.error));
  }
  const validated = parseResult.data;

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

  // Validate distribution entries: if any entry has weight, all must have weight
  for (const [modelName, entries] of Object.entries(validated.modelRouting)) {
    const hasAnyWeight = entries.some(e => e.weight !== undefined);
    if (hasAnyWeight) {
      const allHaveWeight = entries.every(e => e.weight !== undefined);
      if (!allHaveWeight) {
        throw new Error(
          `modelRouting for model "${modelName}": all entries must have a weight when distribution is enabled`
        );
      }
      // Warn about weight: 0 entries — they are valid but will never receive traffic
      const zeroWeightEntries = entries.filter(e => e.weight === 0);
      if (zeroWeightEntries.length > 0) {
        console.warn(
          `[config] modelRouting for "${modelName}": ${zeroWeightEntries.length} provider(s) have weight: 0 — they will not receive traffic via weighted distribution`
        );
      }
      if (entries.length < 2) {
        throw new Error(
          `modelRouting for model "${modelName}": distribution requires at least 2 providers`
        );
      }
    }
  }

  // Build typed config — cache parsed URL components per provider (avoids per-request URL parsing)
  const providers = new Map<string, ProviderConfig>();
  try {
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
      modelPools: p.modelPools !== undefined ? { ...p.modelPools } : undefined,
    };
    try {
      const parsedUrl = new URL(p.baseUrl);
      providerConfig._cachedHost = parsedUrl.host;
      providerConfig._cachedOrigin = `${parsedUrl.protocol}//${parsedUrl.host}`;
      providerConfig._cachedPathname = parsedUrl.pathname.replace(/\/+$/, "");
    } catch {
      // If baseUrl is invalid, skip caching — buildOutboundHeaders will fall back gracefully
    }
    // Per-model agent map — agents created lazily on first request per model ID
    providerConfig._agents = new Map<string, import("undici").Agent>();
    providerConfig.poolSize = p.poolSize ?? 10;
    providerConfig._connectionRetries = p.connectionRetries;
    providerConfig._staleAgentThresholdMs = p.staleAgentThresholdMs;
    // Create per-provider circuit breaker
    const cbConfig = p.circuitBreaker;
    providerConfig._circuitBreaker = new CircuitBreaker(cbConfig ? {
      failureThreshold: cbConfig.failureThreshold,
      windowSeconds: cbConfig.windowSeconds,
      cooldownSeconds: cbConfig.cooldownSeconds,
    } : undefined);
    providers.set(name, providerConfig);
  }

  // Wire server config to each provider so proxy.ts can access buffer settings
  const serverConfig: ServerConfig = {
    port: validated.server.port,
    host: validated.server.host,
    streamBufferMs: validated.server.streamBufferMs,
    streamBufferBytes: validated.server.streamBufferBytes,
    globalBackoffEnabled: validated.server.globalBackoffEnabled,
    unhealthyThreshold: validated.server.unhealthyThreshold,
    maxBodySizeMB: validated.server.maxBodySizeMB,
    sessionIdleTtlMs: validated.server.sessionIdleTtlMs,
  };
  for (const [, provider] of providers) {
    provider._serverConfig = serverConfig;
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

  const config: AppConfig = {
    server: serverConfig,
    providers,
    routing,
    tierPatterns,
    modelRouting,
    hedging: validated.hedging ? {
      speculativeDelay: validated.hedging.speculativeDelay,
      cvThreshold: validated.hedging.cvThreshold,
      maxHedge: validated.hedging.maxHedge,
    } : undefined,
  };

  // Apply project-level routing overlay when loading global config
  if (path && !path.endsWith("modelweaver.yaml")) {
    const localPath = join(cwd ?? process.cwd(), "modelweaver.yaml");
    if (existsSync(localPath)) {
      const projectRouting = loadProjectRoutingOverlay(cwd ?? process.cwd());
      if (projectRouting) {
        for (const [alias, entries] of projectRouting) {
          config.modelRouting.set(alias, entries);
        }
      }
    }
  }

  return { config, configPath: path };
  } catch (e) {
    // Close any agents that were created for providers before the error
    for (const [, provider] of providers) {
      if (provider._agents && provider._agents.size > 0) {
        await Promise.allSettled([...provider._agents.values()].map(a => a.close()));
      }
    }
    throw e;
  }
}

// --- Reload helper ---

export async function reloadConfig(configPath: string): Promise<AppConfig> {
  const { config } = await loadConfig(configPath);
  return config;
}
