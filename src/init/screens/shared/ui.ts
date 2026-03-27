// src/init/screens/shared/ui.ts

import prompts from 'prompts';

// Color codes (from existing init.ts)
export const GREEN = '\x1B[32m';
export const RED = '\x1B[31m';
export const CYAN = '\x1B[36m';
export const BOLD = '\x1B[1m';
export const RESET = '\x1B[0m';

export function check(msg: string): void {
  console.log(`  ${GREEN}\u2713${RESET} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${RED}\u2717${RESET} ${msg}`);
}

export function clearScreen(): void {
  console.log(`\n${'\u2500'.repeat(56)}\n`);
}

export class GoBackError extends Error {
  constructor() {
    super('__back__');
    this.name = 'GoBackError';
  }
}

export const CANCEL = { onCancel: () => { throw new GoBackError(); } };

export async function promptText(label: string, initial?: string): Promise<string> {
  const response = await prompts({
    type: 'text',
    name: 'value',
    message: label,
    initial: initial ?? '',
  }, CANCEL);
  return response.value as string;
}

export async function promptNumber(label: string, initial?: number): Promise<number> {
  const response = await prompts({
    type: 'number',
    name: 'value',
    message: label,
    initial: initial ?? 0,
  }, CANCEL);
  return response.value as number;
}

export async function promptConfirm(label: string, initial = true): Promise<boolean> {
  const response = await prompts({
    type: 'confirm',
    name: 'value',
    message: label,
    initial,
  }, CANCEL);
  return response.value as boolean;
}

export async function promptSelect<T extends string | number>(
  label: string,
  choices: { title: string; value: T }[],
  initial?: T,
): Promise<T> {
  const response = await prompts({
    type: 'select',
    name: 'value',
    message: label,
    choices,
    initial: initial ?? 0,
  }, CANCEL);
  return response.value as T;
}

export async function promptMultiSelect<T extends string | number>(
  label: string,
  choices: { title: string; value: T }[],
  hint?: string,
): Promise<T[]> {
  const response = await prompts({
    type: 'multiselect',
    name: 'value',
    message: label,
    choices,
    hint: hint ?? '',
  }, CANCEL);
  return response.value as T[];
}

export async function promptPassword(label: string): Promise<string> {
  const response = await prompts({
    type: 'password',
    name: 'value',
    message: label,
  }, CANCEL);
  return response.value as string;
}

export function box(lines: string[], width = 58): void {
  const top = `\u250c${'\u2500'.repeat(width - 2)}\u2510`;
  const mid = `\u251c${'\u2500'.repeat(width - 2)}\u2524`;
  const bot = `\u2514${'\u2500'.repeat(width - 2)}\u2518`;
  const side = '\u2502';

  console.log(top);
  for (const line of lines) {
    const padded = line.padEnd(width - 2).slice(0, width - 2);
    console.log(`${side} ${padded} ${side}`);
  }
  console.log(bot);
}

export function boxWithHeader(title: string, lines: string[], width = 58): void {
  const top = `\u250c${'\u2500'.repeat(width - 2)}\u2510`;
  const mid = `\u251c${'\u2500'.repeat(width - 2)}\u2524`;
  const bot = `\u2514${'\u2500'.repeat(width - 2)}\u2518`;
  const side = '\u2502';
  const titleLine = ` ${BOLD}${title}${RESET}`;

  console.log(top);
  console.log(`${side}${titleLine.padEnd(width - 1)}${side}`);
  console.log(mid);
  for (const line of lines) {
    const padded = line.padEnd(width - 2).slice(0, width - 2);
    console.log(`${side} ${padded} ${side}`);
  }
  console.log(bot);
}

export function boxLine(label: string, value: string, width = 58): string {
  return `${label.padEnd(width - value.length - 3)}${CYAN}${value}${RESET}`;
}
