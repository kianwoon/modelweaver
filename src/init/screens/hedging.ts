// src/init/screens/hedging.ts

import type { WizardState, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, clearScreen,
  promptNumber, promptSelect, promptText,
  RED, RESET,
} from './shared/ui.js';

export function renderHedging(state: WizardState): Promise<ScreenAction> {
  clearScreen();
  const lines: string[] = [];
  lines.push(boxLine('speculativeDelay:', `${state.hedging.speculativeDelay} ms`));
  lines.push(boxLine('cvThreshold:', String(state.hedging.cvThreshold)));
  lines.push(boxLine('maxHedge:', String(state.hedging.maxHedge)));
  lines.push('');
  lines.push('  e. Edit hedging settings');
  lines.push('  b. Back to main menu');
  boxWithHeader('Hedging Settings', lines);

  return handleInput(state);
}

async function handleInput(state: WizardState): Promise<ScreenAction> {
  const action = await promptSelect('Choose action:', [
    { title: 'Edit hedging settings', value: 'e' },
    { title: 'Back to main menu', value: 'b' },
  ]);

  if (action === 'e') {
    return await editHedging(state);
  }
  return { type: 'back' };
}

async function editHedging(state: WizardState): Promise<ScreenAction> {
  const speculativeDelay = await promptNumber('Delay before starting backup (ms):', state.hedging.speculativeDelay);
  const cvThreshold = await promptNumber('CV threshold (0-10):', state.hedging.cvThreshold);
  const maxHedge = await promptNumber('Max hedged copies per request:', state.hedging.maxHedge);

  if (speculativeDelay < 1) {
    console.log(`  ${RED}Invalid speculativeDelay. Must be a positive integer.${RESET}`);
    await promptText('Press Enter to continue...', '');
    return renderHedging(state);
  }
  if (cvThreshold < 0 || cvThreshold > 10) {
    console.log(`  ${RED}Invalid cvThreshold. Must be between 0 and 10.${RESET}`);
    await promptText('Press Enter to continue...', '');
    return renderHedging(state);
  }
  if (maxHedge < 1 || maxHedge > 10) {
    console.log(`  ${RED}Invalid maxHedge. Must be between 1 and 10.${RESET}`);
    await promptText('Press Enter to continue...', '');
    return renderHedging(state);
  }

  state.hedging.speculativeDelay = speculativeDelay;
  state.hedging.cvThreshold = cvThreshold;
  state.hedging.maxHedge = maxHedge;

  return renderHedging(state);
}
