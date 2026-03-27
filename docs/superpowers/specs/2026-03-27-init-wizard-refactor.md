# Init Wizard Refactor — Design Spec

> **Goal:** Refactor the ModelWeaver init wizard into a clean section-based editor with separated concerns and readable code.

**Architecture:** Section-based TTY editor with 5 top-level screens (Providers, Models, Distribution, Fallback, Server). Main loop is a state machine dispatching to screen modules. No forced sequential flow — jump to any section from the main menu.

**Tech Stack:** TypeScript, `blessed` (or `inquirer`-style prompts), existing config.ts / env helpers.

---

## Screen: Main Menu

```
╔══════════════════════════════════════════════╗
║       ModelWeaver Configuration              ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. Providers               [2 configured]   ║
║  2. Models                  [5 configured]  ║
║  3. Distribution            [2 rules]        ║
║  4. Fallback chains         [1 chain]       ║
║  5. Server settings                         ║
║                                              ║
║  s. Save and exit                            ║
║  q. Quit without saving                     ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Behavior:**
- Press `1-5` → enter that section
- Press `s` → validate config, write config.yaml + .env, exit
- Press `q` → exit without saving (no confirmation)
- Press `?` → show help
- After any section action, return to this main screen
- Counts update dynamically (e.g., `[3 rules]` after adding a distribution)
- Fresh install (no existing config): pre-populate with glm and minimax as empty providers

---

## Screen: Providers

```
╔══════════════════════════════════════════════╗
║  Providers                                   ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. glm              ✓ key set               ║
║  2. minimax          ✓ key set               ║
║                                              ║
║  a. Add provider     e. Edit                 ║
║  t. Test API key     d. Delete               ║
║  b. Back                                     ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Fields per provider:**
- `name` — unique identifier
- `baseUrl` — upstream API base URL
- `apiKey` — API key (saved to .env, not config.yaml)
- `timeout` — total request timeout in ms (default: 60000)
- `ttfbTimeout` — time to first byte timeout in ms (default: 30000)
- `circuitBreaker.threshold` — failure count before opening (default: 3)
- `circuitBreaker.cooldown` — cooldown in seconds (default: 60)

**Actions:**
- `e` → select provider by number → edit fields one at a time (back to list after each)
- `t` → select provider → test API key (multi-model loop: sonnet → haiku → opus)
- `d` → select provider → confirm → delete. If provider is referenced by Distribution or Fallback, warn and offer to remove those rules or cancel deletion.
- `a` → add provider: prompts for name, baseUrl, apiKey, then defaults for the rest

---

## Screen: Models

```
╔══════════════════════════════════════════════╗
║  Models                                      ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. MiniMax-M2.7                            ║
║  2. glm-5-turbo                            ║
║  3. glm-4.7                                ║
║  4. glm-5                                   ║
║  5. glm-5.1                                ║
║                                              ║
║  a. Add model      d. Delete                ║
║  b. Back                                   ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Behavior:**
- Lists model alias names only — no routing details
- `a` → prompt for model alias name, add to list (no routing yet)
- `d` → select model → confirm → delete. If model has Distribution or Fallback rules, warn and remove those rules or cancel.
- Duplicate alias names rejected
- Routing is configured in Distribution or Fallback sections

---

## Screen: Distribution

```
╔══════════════════════════════════════════════╗
║  Distribution                                ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. MiniMax-M2.7         3 providers        ║
║  2. glm-5-turbo         2 providers        ║
║  3. glm-5.1             2 providers        ║
║                                              ║
║  a. Add rule        e. Edit         d. Delete║
║  b. Back                                    ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Detail view** (after `e` on a rule):

```
╔══════════════════════════════════════════════╗
║  Distribution: MiniMax-M2.7                  ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. minimax  → MiniMax-M2.7      weight: 40 ║
║  2. glm      → glm-5.1           weight: 40 ║
║  3. glm      → glm-5-turbo       weight: 20 ║
║                                              ║
║  Total weight: 100 ✓                         ║
║                                              ║
║  a. Add entry      e. Edit weight   d. Remove║
║  b. Back                                    ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Behavior:**
- `a` → add entry: select provider (from configured providers), enter model name, enter weight
- `e` → select entry, edit weight (number prompt)
- `d` → select entry, remove from distribution
- Shows running total weight with `✓` if 100, `✗` if not
- A model can only appear in Distribution OR Fallback, not both (validation error if conflict)
- Selecting a model for Distribution that already has Fallback rules: warn and remove Fallback rules, or cancel

---

## Screen: Fallback Chains

```
╔══════════════════════════════════════════════╗
║  Fallback Chains                            ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. glm-5             2 providers           ║
║                                              ║
║  a. Add chain       e. Edit         d. Delete║
║  b. Back                                    ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Detail view** (after `e` on a chain):

```
╔══════════════════════════════════════════════╗
║  Fallback: glm-5                           ║
╠══════════════════════════════════════════════╣
║                                              ║
║  1. glm → glm-5             (primary)      ║
║  2. glm → glm-4.7           (fallback #1) ║
║                                              ║
║  a. Add entry       d. Remove       r. Reorder║
║  b. Back                                    ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Behavior:**
- `a` → add entry: select provider, enter model name, append to end of chain
- `d` → select entry, remove from chain
- `r` → select entry, select new position (swap)
- Entry 1 labeled `(primary)`, rest labeled `(fallback #N)`
- No weights — pure sequential fallback
- Same model-in-both-sections protection as Distribution

---

## Screen: Server Settings

```
╔══════════════════════════════════════════════╗
║  Server Settings                            ║
╠══════════════════════════════════════════════╣
║                                              ║
║  Port:        3456                          ║
║  Host:        localhost                     ║
║                                              ║
║  e. Edit                                     ║
║  b. Back                                    ║
║                                              ║
╚══════════════════════════════════════════════╝
```

**Behavior:**
- `e` → prompts for port and host
- Validation: port 1-65535, host must be valid hostname/IP
- Pre-populated from existing config

---

## Save & Validation

**On `s` (Save and exit) from main menu:**

Validation checks (must all pass before saving):
1. At least one provider configured with API key set
2. At least one model alias exists
3. Every model with Distribution entries: weights sum to exactly 100
4. Every model in Distribution: all referenced providers exist
5. Every model in Fallback: all referenced providers exist
6. No model appears in both Distribution and Fallback
7. Server port is valid
8. Every model alias has at least one routing entry (Distribution or Fallback). Non-blocking warning only — still allows save.

If validation fails: show errors (blocking) and warnings (non-blocking), return to main menu (don't exit on errors).

On success: write `~/.modelweaver/config.yaml` and `~/.modelweaver/.env`, exit with success message.

---

## Code Architecture

```
src/
  init.ts               ← main entry, menu loop, state machine (~200 lines)
  screens/
    providers.ts        ← Provider list, add/edit/delete/test (~300 lines)
    models.ts           ← Model alias list, add/delete (~150 lines)
    distribution.ts     ← Distribution list + detail view (~250 lines)
    fallback.ts         ← Fallback chain list + detail view (~200 lines)
    server.ts           ← Server settings view (~100 lines)
  shared/
    ui.ts               ← box(), prompt(), confirm(), select() helpers
    config.ts           ← peekConfig() / writeConfig() (reuse existing)
    env.ts               ← .env read/write helpers
    validate.ts         ← validateConfig() for save gate
```

**Screen interface:**
```typescript
type ScreenAction = { type: 'back' } | { type: 'quit' } | { type: 'save' } | { type: 'navigate', section: string };
function renderScreen(state: WizardState, screen: Screen): ScreenAction;
```

**WizardState:**
```typescript
interface WizardState {
  providers: Map<string, ProviderConfig>;
  models: string[];  // alias names
  distribution: Map<string, RoutingEntry[]>;  // model alias → entries with weights
  fallback: Map<string, RoutingEntry[]>;  // model alias → sequential chain
  server: { port: number; host: string };
  envKeys: Map<string, string>;  // provider name → API key
}
```

**Key design decisions:**
- Drop `--quick` init mode entirely — new wizard is simple enough
- No forced sequential flow — user navigates freely between sections
- API keys always stored in `.env`, never in `config.yaml`
- Delete/edit operations cascade properly (delete provider warns about routing references)
