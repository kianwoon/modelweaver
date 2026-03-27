// src/init/screens/server.ts

import type { WizardState, ScreenAction } from './shared/types.js';
import {
  boxWithHeader, boxLine, clearScreen, CYAN, RESET, RED,
  promptNumber, promptText, promptSelect, CANCEL, GoBackError,
} from './shared/ui.js';

export function renderServer(state: WizardState): Promise<ScreenAction> {
  clearScreen();
  const lines: string[] = [];
  lines.push(boxLine('Port:', String(state.server.port)));
  lines.push(boxLine('Host:', state.server.host));
  lines.push('');
  lines.push('  e. Edit settings');
  lines.push('  b. Back to main menu');
  boxWithHeader('Server Settings', lines);

  return handleInput(state);
}

async function handleInput(state: WizardState): Promise<ScreenAction> {
  const action = await promptSelect('Choose action:', [
    { title: 'Edit settings', value: 'e' },
    { title: 'Back to main menu', value: 'b' },
  ]);

  if (action === 'e') {
    return await editServer(state);
  }
  return { type: 'back' };
}

async function editServer(state: WizardState): Promise<ScreenAction> {
  const port = await promptNumber('Port:', state.server.port);
  const host = await promptText('Host:', state.server.host);
  if (port < 1 || port > 65535) {
    console.log(`  ${RED}Invalid port. Must be 1-65535.${RESET}`);
    await promptText('Press Enter to continue...', '');
  } else {
    state.server.port = port;
    state.server.host = host;
  }
  return renderServer(state);
}
