// src/init/screens/distribution.ts

import type { WizardState, RoutingEntry, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, clearScreen, check, fail,
  GREEN, RED, CYAN, BOLD, RESET,
  promptText, promptNumber, promptConfirm, promptSelect,
  GoBackError,
} from './shared/ui.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function totalWeight(entries: RoutingEntry[]): number {
  return entries.reduce((sum, e) => sum + (e.weight ?? 0), 0);
}

function formatRule(alias: string, entries: RoutingEntry[]): string {
  const w = totalWeight(entries);
  const color = w === 100 ? GREEN : RED;
  const count = entries.length;
  return `  ${BOLD}${alias}${RESET}  ${count} provider${count !== 1 ? 's' : ''}  weight=${color}${w}${RESET}`;
}

async function pickModelAlias(state: WizardState, label: string): Promise<string> {
  // Models not yet in distribution OR fallback
  const available = state.models.filter(
    (m) => !state.distribution.has(m) && !state.fallback.has(m),
  );

  if (available.length === 0) {
    fail('No available models. Add a model first.');
    throw new GoBackError();
  }

  const choices = available.map((m) => ({ title: m, value: m }));
  return promptSelect(label, choices);
}

async function pickProvider(state: WizardState, label: string): Promise<string> {
  const entries = Array.from(state.providers.entries());
  if (entries.length === 0) {
    fail('No providers configured.');
    throw new GoBackError();
  }

  const choices = entries.map(([id, p]) => ({
    title: `${id}  (${p.baseUrl})`,
    value: id,
  }));

  return promptSelect(label, choices);
}

// ---------------------------------------------------------------------------
// Detail view — edit a single distribution rule
// ---------------------------------------------------------------------------

async function editRule(
  state: WizardState,
  alias: string,
  entries: RoutingEntry[],
): Promise<RoutingEntry[]> {
  while (true) {
    clearScreen();

    const w = totalWeight(entries);
    const weightColor = w === 100 ? GREEN : RED;

    const lines: string[] = [];

    // Header row
    lines.push(`  ${BOLD}${alias}${RESET}  —  total weight: ${weightColor}${w}${RESET}${w !== 100 ? ` ${RED}(should be 100)${RESET}` : ''}`);
    lines.push('');

    // Entries
    if (entries.length === 0) {
      lines.push('  (no entries yet)');
    } else {
      entries.forEach((e, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. ${BOLD}${e.provider}${RESET} → ${e.model}  weight=${CYAN}${e.weight ?? 0}${RESET}`);
      });
    }

    lines.push('');
    lines.push('  a. Add entry          e. Edit weight');
    lines.push('  d. Remove entry       s. Save & done');
    lines.push('  c. Cancel (discard)');

    boxWithHeader('Edit Distribution Rule', lines);

    const action = await promptSelect('Action:', [
      { title: 'Add entry', value: 'a' },
      { title: 'Edit weight', value: 'e' },
      { title: 'Remove entry', value: 'd' },
      { title: 'Save & done', value: 's' },
      { title: 'Cancel', value: 'c' },
    ]);

    switch (action) {
      case 'a': {
        // Add entry: provider → model → weight
        const providerId = await pickProvider(state, 'Select provider');
        const modelName = await promptText('Model name on this provider');
        if (!modelName) throw new GoBackError();

        const weight = await promptNumber('Weight', 1);
        if (weight <= 0) {
          fail('Weight must be > 0');
          break;
        }

        entries.push({ provider: providerId, model: modelName, weight });
        break;
      }

      case 'e': {
        // Edit weight of an existing entry
        if (entries.length === 0) {
          fail('No entries to edit.');
          break;
        }

        const idxChoices = entries.map((e, i) => ({
          title: `${i + 1}. ${e.provider} → ${e.model}  (current weight=${e.weight})`,
          value: i,
        }));
        const idx = await promptSelect('Select entry to edit weight', idxChoices);
        const newWeight = await promptNumber('New weight', entries[idx].weight ?? 1);
        if (newWeight <= 0) {
          fail('Weight must be > 0');
          break;
        }
        entries[idx].weight = newWeight;
        check('Weight updated.');
        break;
      }

      case 'd': {
        // Remove entry
        if (entries.length === 0) {
          fail('No entries to remove.');
          break;
        }

        const idxChoices = entries.map((e, i) => ({
          title: `${i + 1}. ${e.provider} → ${e.model}`,
          value: i,
        }));
        const idx = await promptSelect('Select entry to remove', idxChoices);
        entries.splice(idx, 1);
        check('Entry removed.');
        break;
      }

      case 's': {
        // Save — caller will persist to state
        return entries;
      }

      case 'c': {
        // Discard changes
        throw new GoBackError();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export async function renderDistribution(state: WizardState): Promise<ScreenAction> {
  while (true) {
    clearScreen();

    const rules = Array.from(state.distribution.entries());

    if (rules.length === 0) {
      const lines = ['  No distribution rules configured yet.'];
      lines.push('');
      lines.push('  a. Add rule');
      lines.push('  b. Back');
      boxWithHeader('Distribution (Weighted Routing)', lines);
    } else {
      const lines = rules.map(([alias, entries]) => formatRule(alias, entries));
      lines.push('');
      lines.push('  a. Add rule        e. Edit rule');
      lines.push('  d. Delete rule     b. Back');
      boxWithHeader('Distribution (Weighted Routing)', lines);
    }

    const choices = rules.length === 0
      ? [
          { title: 'Add rule', value: 'a' },
          { title: 'Back', value: 'b' },
        ]
      : [
          { title: 'Add rule', value: 'a' },
          { title: 'Edit rule', value: 'e' },
          { title: 'Delete rule', value: 'd' },
          { title: 'Back', value: 'b' },
        ];

    const action = await promptSelect('Choose action:', choices);

    switch (action) {
      case 'a': {
        // Add new distribution rule
        clearScreen();
        boxWithHeader('Add Distribution Rule', []);

        const alias = await pickModelAlias(state, 'Select model alias for this rule');
        const entries: RoutingEntry[] = [];

        while (true) {
          clearScreen();

          const w = totalWeight(entries);
          const weightColor = w === 100 ? GREEN : RED;

          const lines: string[] = [];
          lines.push(`  ${BOLD}${alias}${RESET}  —  total weight: ${weightColor}${w}${RESET}${w !== 100 ? ` ${RED}(should be 100)${RESET}` : ''}`);
          lines.push('');

          if (entries.length === 0) {
            lines.push('  (no entries yet)');
          } else {
            entries.forEach((e, i) => {
              lines.push(`  ${String(i + 1).padStart(2)}. ${BOLD}${e.provider}${RESET} → ${e.model}  weight=${CYAN}${e.weight ?? 0}${RESET}`);
            });
          }

          lines.push('');
          lines.push('  a. Add entry    s. Save rule    c. Cancel');

          boxWithHeader('Add Distribution Rule', lines);

          const sub = await promptSelect('Action:', [
            { title: 'Add entry', value: 'a' },
            { title: 'Save rule', value: 's' },
            { title: 'Cancel', value: 'c' },
          ]);

          if (sub === 'a') {
            const providerId = await pickProvider(state, 'Select provider');
            const modelName = await promptText('Model name on this provider');
            if (!modelName) throw new GoBackError();

            const weight = await promptNumber('Weight', 1);
            if (weight <= 0) {
              fail('Weight must be > 0');
              await promptText('Press Enter to continue...', '');
              continue;
            }

            entries.push({ provider: providerId, model: modelName, weight });
          } else if (sub === 's') {
            if (entries.length === 0) {
              fail('Add at least one entry before saving.');
              await promptText('Press Enter to continue...', '');
              continue;
            }
            // Save
            state.distribution.set(alias, entries);
            check(`Distribution rule for "${alias}" saved.`);
            await promptText('Press Enter to continue...', '');
            break;
          } else {
            throw new GoBackError();
          }
        }

        break;
      }

      case 'e': {
        // Edit existing rule
        const ruleChoices = rules.map(([alias, entries]) => ({
          title: `${alias}  (${entries.length} providers, weight=${totalWeight(entries)})`,
          value: alias,
        }));
        const alias = await promptSelect('Select rule to edit', ruleChoices);
        const entries = state.distribution.get(alias);
        if (!entries) throw new GoBackError();

        // Work on a copy
        const edited = await editRule(state, alias, [...entries]);
        // Persist
        state.distribution.set(alias, edited);
        check(`Distribution rule for "${alias}" updated.`);
        await promptText('Press Enter to continue...', '');
        break;
      }

      case 'd': {
        // Delete rule
        if (rules.length === 0) {
          fail('No rules to delete.');
          break;
        }

        const ruleChoices = rules.map(([alias]) => ({ title: alias, value: alias }));
        const alias = await promptSelect('Select rule to delete', ruleChoices);
        const confirmed = await promptConfirm(`Delete distribution rule for "${alias}"?`);
        if (!confirmed) throw new GoBackError();

        state.distribution.delete(alias);
        check(`Distribution rule for "${alias}" deleted.`);
        break;
      }

      case 'b': {
        return { type: 'back' };
      }
    }
  }
}
