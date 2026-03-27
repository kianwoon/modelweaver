// src/init/screens/models.ts

import type { WizardState, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, clearScreen,
  GREEN, CYAN, RESET, RED,
  promptText, promptConfirm, promptSelect, GoBackError,
} from './shared/ui.js';

export async function renderModels(state: WizardState): Promise<ScreenAction> {
  clearScreen();
  const lines: string[] = [];

  for (let i = 0; i < state.models.length; i++) {
    const alias = state.models[i];
    const routingType = state.distribution.has(alias)
      ? `${CYAN}[distribution]${RESET}`
      : state.fallback.has(alias)
      ? `${CYAN}[fallback]${RESET}`
      : `${RED}[no routing]${RESET}`;
    lines.push(`  ${String(i + 1).padStart(2)}. ${alias.padEnd(22)} ${routingType}`);
  }

  if (state.models.length === 0) {
    lines.push('  (no models configured)');
  }

  lines.push('');
  lines.push('  a. Add model      d. Delete model');
  lines.push('  b. Back to main menu');

  boxWithHeader('Models', lines);

  return handleInput(state);
}

async function handleInput(state: WizardState): Promise<ScreenAction> {
  const choices = [
    { title: 'Add model', value: 'a' },
    { title: 'Delete model', value: 'd' },
    { title: 'Back to main menu', value: 'b' },
  ];
  const action = await promptSelect('Choose action:', choices);
  switch (action) {
    case 'a': return await addModel(state);
    case 'd': return await deleteModel(state);
    case 'b': return { type: 'back' };
  }
  return { type: 'back' };
}

async function addModel(state: WizardState): Promise<ScreenAction> {
  const alias = await promptText('Model alias name:');
  if (!alias.trim()) throw new GoBackError();
  if (state.models.includes(alias)) {
    console.log(`  ${RED}Model "${alias}" already exists${RESET}`);
    await promptText('Press Enter to continue...', '');
    return await renderModels(state);
  }
  state.models.push(alias.trim());
  return await renderModels(state);
}

async function deleteModel(state: WizardState): Promise<ScreenAction> {
  if (state.models.length === 0) {
    await promptText('No models to delete. Press Enter...', '');
    return await renderModels(state);
  }
  const choices = state.models.map((m, i) => ({ title: m, value: i }));
  choices.push({ title: 'Cancel', value: -1 });
  const idx = await promptSelect('Select model to delete:', choices);
  if (idx === -1) return await renderModels(state);

  const alias = state.models[idx];
  const hasDist = state.distribution.has(alias);
  const hasFb = state.fallback.has(alias);
  if (hasDist || hasFb) {
    console.log(`  ${RED}Warning: "${alias}" has ${hasDist ? 'distribution' : ''}${hasDist && hasFb ? ' and ' : ''}${hasFb ? 'fallback' : ''} rules${RESET}`);
    const confirm2 = await promptConfirm(`Delete model AND its routing rules? (otherwise cancel)`);
    if (confirm2) {
      state.distribution.delete(alias);
      state.fallback.delete(alias);
      state.models.splice(idx, 1);
    }
  } else {
    const confirm1 = await promptConfirm(`Delete model "${alias}"?`);
    if (confirm1) state.models.splice(idx, 1);
  }
  return await renderModels(state);
}
