import chalk from 'chalk';
import { adapters } from '../parsers/registry.js';
import type { SessionSource, UnifiedSession } from '../types/index.js';

/**
 * Source-specific colors for consistent branding -- derived from the adapter registry
 */
export const sourceColors = Object.fromEntries(Object.values(adapters).map((a) => [a.name, a.color])) as Record<
  SessionSource,
  (s: string) => string
>;

/**
 * Format session with colors in columnar layout
 * Format: [source]  YYYY-MM-DD HH:MM  project-name  summary...  short-id
 */
export function formatSessionColored(session: UnifiedSession): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`;
  const source = colorFn(tag.padEnd(10));

  const date = chalk.gray(session.updatedAt.toISOString().slice(0, 16).replace('T', ' '));

  // Show repo or last folder of cwd
  const repoDisplay = session.repo || session.cwd.split('/').slice(-2).join('/') || '';
  const repo = chalk.cyan(repoDisplay.slice(0, 20).padEnd(20));

  // Summary - truncate nicely
  const summaryText = session.summary || '(no summary)';
  const summary = (session.summary ? chalk.white(summaryText.slice(0, 44)) : chalk.gray(summaryText)).padEnd(44);

  // Short ID
  const id = chalk.gray(session.id.slice(0, 8));

  return `${source} ${date}  ${repo}  ${summary}  ${id}`;
}

// ponytail: approximate East Asian Wide ranges (CJK, Hangul, fullwidth, emoji); use a width table if odd scripts wrap
const WIDE_CHAR = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1faff}]/u;

/** Cut text to at most `columns` terminal columns; wide characters take two. */
function fitColumns(text: string, columns: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    used += WIDE_CHAR.test(ch) ? 2 : 1;
    if (used > columns) break;
    out += ch;
  }
  return out;
}

/**
 * Format session for clack select - simpler, cleaner.
 * The summary gets whatever the terminal width leaves (at least 16 columns).
 */
export function formatSessionForSelect(session: UnifiedSession, columns = process.stdout.columns || 80): string {
  const colorFn = sourceColors[session.source] || chalk.white;
  const tag = `[${session.source}]`.padEnd(10);
  const date = session.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
  const repoDisplay = ((session.repo || session.cwd).split(/[\\/]/).filter(Boolean).pop() || '')
    .slice(0, 18)
    .padEnd(18);
  // clack wraps rows at columns minus its coloured "│  " prefix (13 chars counting ANSI codes),
  // then adds "● " before and " (12345678)" after the active row: 26 columns of overhead.
  const summaryColumns = Math.max(16, columns - `${tag}  ${date}  ${repoDisplay}  `.length - 26);
  const summary = fitColumns(session.summary || '(no summary)', summaryColumns);

  return `${colorFn(tag)}  ${date}  ${chalk.cyan(repoDisplay)}  ${summary}`;
}
