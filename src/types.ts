export interface ProviderConfig {
  name: string;
  baseUrl: string;
  apiKey: string;
  timeout: number;
  authType?: "anthropic" | "bearer";
}

export interface RoutingEntry {
  provider: string;
  model?: string;
}

export interface TierConfig {
  name: string;
  entries: RoutingEntry[];
}

export interface ServerConfig {
  port: number;
  host: string;
}

export interface AppConfig {
  server: ServerConfig;
  providers: Map<string, ProviderConfig>;
  routing: Map<string, RoutingEntry[]>;
  tierPatterns: Map<string, string[]>;
  modelRouting: Map<string, RoutingEntry[]>;
}

export interface RequestContext {
  requestId: string;
  model: string;
  tier: string;
  providerChain: RoutingEntry[];
  startTime: number;
  rawBody: string;
}
