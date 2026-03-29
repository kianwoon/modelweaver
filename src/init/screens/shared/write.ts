// src/init/screens/shared/write.ts

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { stringify } from "yaml";
import type { WizardState } from "./types.js";
import { fail } from "./ui.js";

/**
 * Converts WizardState to YAML config string.
 * - providers: baseUrl, timeout, ttfbTimeout, circuitBreaker, apiKey as ${ENV_KEY}
 * - modelRouting: merged from distribution (with weight) and fallback (without weight)
 * - server: port and host
 */
export function buildYamlConfig(state: WizardState): string {
  // Build providers object
  const providers: Record<string, object> = {};
  for (const [id, provider] of state.providers) {
    providers[id] = {
      baseUrl: provider.baseUrl,
      apiKey: `\${${provider.envKey}}`,
      timeout: provider.timeout,
      ttfbTimeout: provider.ttfbTimeout,
      authType: provider.authType,
      circuitBreaker: {
        failureThreshold: provider.circuitBreaker.threshold,
        cooldownSeconds: provider.circuitBreaker.cooldown,
      },
    };
  }

  // Build modelRouting by merging distribution and fallback
  const modelRouting: Record<string, object[]> = {};

  // Add distribution entries (with weight)
  for (const [modelAlias, entries] of state.distribution) {
    modelRouting[modelAlias] = entries.map((entry) => ({
      provider: entry.provider,
      model: entry.model,
      weight: entry.weight,
    }));
  }

  // Add fallback entries (without weight)
  for (const [modelAlias, entries] of state.fallback) {
    if (!modelRouting[modelAlias]) {
      modelRouting[modelAlias] = [];
    }
    for (const entry of entries) {
      modelRouting[modelAlias].push({
        provider: entry.provider,
        model: entry.model,
      });
    }
  }

  // Build the full config object
  const config = {
    server: {
      port: state.server.port,
      host: state.server.host,
    },
    providers,
    modelRouting,
  };

  return stringify(config);
}

/**
 * Writes .env file with API keys.
 * - If file exists, reads existing content and updates only keys present in state
 * - Preserves other environment variables
 */
export function writeEnvFile(state: WizardState, envDir: string): void {
  const envPath = join(envDir, ".env");

  // Read existing .env if it exists
  let existingEnv: Record<string, string> = {};
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith("#")) {
        const eqIndex = trimmed.indexOf("=");
        if (eqIndex > 0) {
          const key = trimmed.slice(0, eqIndex);
          const value = trimmed.slice(eqIndex + 1);
          existingEnv[key] = value;
        }
      }
    }
  }

  // Update with provider env keys
  for (const [, provider] of state.providers) {
    if (provider.envKey && provider.apiKey) {
      existingEnv[provider.envKey] = provider.apiKey;
    }
  }

  // Write back to file — skip if content unchanged
  const lines = Object.entries(existingEnv).map(([key, value]) => `${key}=${value}`);
  const newContent = lines.join("\n") + "\n";
  if (existsSync(envPath)) {
    const currentContent = readFileSync(envPath, "utf-8");
    if (currentContent === newContent) return;
  }
  writeFileSync(envPath, newContent, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Writes WizardState to config files.
 * - Config dir: ~/.modelweaver/
 * - Writes config.yaml and .env
 * - Skips writes when content is unchanged
 */
export function writeStateToFiles(state: WizardState): void {
  const configDir = join(homedir(), ".modelweaver");
  const messages: string[] = [];

  try {
    // Create directory if it doesn't exist
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config.yaml — backup existing, skip if content unchanged
    const yamlContent = buildYamlConfig(state);
    const yamlPath = join(configDir, "config.yaml");
    if (existsSync(yamlPath)) {
      const currentYaml = readFileSync(yamlPath, "utf-8");
      if (currentYaml !== yamlContent) {
        // Create backup before overwriting
        const backupPath = yamlPath + ".bak";
        writeFileSync(backupPath, currentYaml, "utf-8");
        writeFileSync(yamlPath, yamlContent, "utf-8");
        messages.push("Updated config.yaml");
      } else {
        messages.push("No changes to config.yaml");
      }
    } else {
      writeFileSync(yamlPath, yamlContent, "utf-8");
      messages.push("Created config.yaml");
    }

    // Write .env — skip if content unchanged
    const envPath = join(configDir, ".env");
    const envBefore = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    writeEnvFile(state, configDir);
    const envAfter = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";
    if (envAfter !== envBefore) {
      messages.push("Updated .env");
    } else {
      messages.push("No changes to .env");
    }

    // Print summary
    process.stdout.write(`\n${messages.join("\n")}\n`);
  } catch (err: unknown) {
    const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined;
    const hint = code === "ENOSPC"
      ? "No disk space available"
      : code === "EACCES"
        ? "Permission denied"
        : err instanceof Error
          ? err.message
          : String(err);
    fail(`Failed to write config: ${hint}`);
  }
}
