// src/init/screens/fallback.ts

import type { WizardState, RoutingEntry, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, clearScreen, check, fail,
  CYAN, BOLD, RESET,
  promptText, promptConfirm, promptSelect,
  GoBackError,
} from './shared/ui.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatChain(alias: string, entries: RoutingEntry[]): string {
  const count = entries.length;
  return `  ${BOLD}${alias}${RESET}  ${count} provider${count !== 1 ? 's' : ''}`;
}

function entryLabel(index: number): string {
  return index === 0 ? '(primary)' : `(fallback #${index})`;
}

async function pickModelAlias(state: WizardState, label: string): Promise<string> {
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
// Detail view — edit a single fallback chain
// ---------------------------------------------------------------------------

async function editChain(
  state: WizardState,
  alias: string,
  entries: RoutingEntry[],
): Promise<RoutingEntry[]> {
  while (true) {
    clearScreen();

    const lines: string[] = [];

    // Header
    lines.push(`  ${BOLD}${alias}${RESET}  —  ${entries.length} step${entries.length !== 1 ? 's' : ''}`);
    lines.push('');

    // Entries
    if (entries.length === 0) {
      lines.push('  (no entries yet)');
    } else {
      entries.forEach((e, i) => {
        const label = entryLabel(i);
        lines.push(`  ${String(i + 1).padStart(2)}. ${BOLD}${e.provider}${RESET} → ${e.model}  ${CYAN}${label}${RESET}`);
      });
    }

    lines.push('');
    lines.push('  a. Add entry       r. Reorder');
    lines.push('  d. Remove entry    s. Save & done');
    lines.push('  c. Cancel (discard)');

    boxWithHeader('Edit Fallback Chain', lines);

    const choices = [
      { title: 'Add entry', value: 'a' },
      { title: 'Remove entry', value: 'd' },
      { title: 'Reorder', value: 'r' },
      { title: 'Save & done', value: 's' },
      { title: 'Cancel', value: 'c' },
    ];

    const action = await promptSelect('Action:', choices);

    switch (action) {
      case 'a': {
        const providerId = await pickProvider(state, 'Select provider');
        const modelName = await promptText('Model name on this provider');
        if (!modelName) throw new GoBackError();

        entries.push({ provider: providerId, model: modelName });
        break;
      }

      case 'd': {
        if (entries.length === 0) {
          fail('No entries to remove.');
          break;
        }

        const idxChoices = entries.map((e, i) => ({
          title: `${i + 1}. ${e.provider} → ${e.model}  ${entryLabel(i)}`,
          value: i,
        }));
        const idx = await promptSelect('Select entry to remove', idxChoices);
        entries.splice(idx, 1);
        check('Entry removed.');
        break;
      }

      case 'r': {
        // Reorder: select entry → select new position → swap
        if (entries.length < 2) {
          fail('Need at least 2 entries to reorder.');
          break;
        }

        const fromChoices = entries.map((e, i) => ({
          title: `${i + 1}. ${e.provider} → ${e.model}  ${entryLabel(i)}`,
          value: i,
        }));
        const fromIdx = await promptSelect('Select entry to move', fromChoices);

        // Position choices exclude the current position
        const toChoices = entries.map((e, i) => ({
          title: `Position ${i + 1}: ${e.provider} → ${e.model}  ${entryLabel(i)}`,
          value: i,
        })).filter((_, i) => i !== fromIdx);

        const toIdx = await promptSelect('Move to which position?', toChoices);

        // Move
        const [moved] = entries.splice(fromIdx, 1);
        entries.splice(toIdx, 0, moved);
        check('Entry moved.');
        break;
      }

      case 's': {
        return entries;
      }

      case 'c': {
        throw new GoBackError();
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export async function renderFallback(state: WizardState): Promise<ScreenAction> {
  while (true) {
    clearScreen();

    const chains = Array.from(state.fallback.entries());

    if (chains.length === 0) {
      const lines = ['  No fallback chains configured yet.'];
      lines.push('');
      lines.push('  a. Add chain');
      lines.push('  b. Back');
      boxWithHeader('Fallback (Sequential Chain)', lines);
    } else {
      const lines = chains.map(([alias, entries]) => formatChain(alias, entries));
      lines.push('');
      lines.push('  a. Add chain        e. Edit chain');
      lines.push('  d. Delete chain     b. Back');
      boxWithHeader('Fallback (Sequential Chain)', lines);
    }

    const choices = chains.length === 0
      ? [
          { title: 'Add chain', value: 'a' },
          { title: 'Back', value: 'b' },
        ]
      : [
          { title: 'Add chain', value: 'a' },
          { title: 'Edit chain', value: 'e' },
          { title: 'Delete chain', value: 'd' },
          { title: 'Back', value: 'b' },
        ];

    const action = await promptSelect('Choose action:', choices);

    switch (action) {
      case 'a': {
        // Add new fallback chain
        clearScreen();
        boxWithHeader('Add Fallback Chain', []);

        const alias = await pickModelAlias(state, 'Select model alias for this chain');
        const entries: RoutingEntry[] = [];

        while (true) {
          clearScreen();

          const lines: string[] = [];
          lines.push(`  ${BOLD}${alias}${RESET}  —  ${entries.length} step${entries.length !== 1 ? 's' : ''}`);
          lines.push('');

          if (entries.length === 0) {
            lines.push('  (no entries yet)');
          } else {
            entries.forEach((e, i) => {
              lines.push(`  ${String(i + 1).padStart(2)}. ${BOLD}${e.provider}${RESET} → ${e.model}  ${CYAN}${entryLabel(i)}${RESET}`);
            });
          }

          lines.push('');
          lines.push('  a. Add entry    s. Save chain    c. Cancel');

          boxWithHeader('Add Fallback Chain', lines);

          const sub = await promptSelect('Action:', [
            { title: 'Add entry', value: 'a' },
            { title: 'Save chain', value: 's' },
            { title: 'Cancel', value: 'c' },
          ]);

          if (sub === 'a') {
            const providerId = await pickProvider(state, 'Select provider');
            const modelName = await promptText('Model name on this provider');
            if (!modelName) throw new GoBackError();

            entries.push({ provider: providerId, model: modelName });
          } else if (sub === 's') {
            if (entries.length === 0) {
              fail('Add at least one entry before saving.');
              await promptText('Press Enter to continue...', '');
              continue;
            }
            state.fallback.set(alias, entries);
            check(`Fallback chain for "${alias}" saved.`);
            await promptText('Press Enter to continue...', '');
            break;
          } else {
            throw new GoBackError();
          }
        }

        break;
      }

      case 'e': {
        // Edit existing chain
        const chainChoices = chains.map(([alias, entries]) => ({
          title: `${alias}  (${entries.length} providers)`,
          value: alias,
        }));
        const alias = await promptSelect('Select chain to edit', chainChoices);
        const entries = state.fallback.get(alias);
        if (!entries) throw new GoBackError();

        const edited = await editChain(state, alias, [...entries]);
        state.fallback.set(alias, edited);
        check(`Fallback chain for "${alias}" updated.`);
        await promptText('Press Enter to continue...', '');
        break;
      }

      case 'd': {
        // Delete chain
        if (chains.length === 0) {
          fail('No chains to delete.');
          break;
        }

        const chainChoices = chains.map(([alias]) => ({ title: alias, value: alias }));
        const alias = await promptSelect('Select chain to delete', chainChoices);
        const confirmed = await promptConfirm(`Delete fallback chain for "${alias}"?`);
        if (!confirmed) throw new GoBackError();

        state.fallback.delete(alias);
        check(`Fallback chain for "${alias}" deleted.`);
        break;
      }

      case 'b': {
        return { type: 'back' };
      }
    }
  }
}
