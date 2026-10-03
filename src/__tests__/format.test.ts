import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { formatSessionForSelect } from '../display/format.js';
import type { UnifiedSession } from '../types/index.js';

function row(summary: string, columns: number): string {
  const session = {
    id: '12345678-aaaa',
    source: 'claude',
    cwd: 'C:\\Users\\me\\automation',
    summary,
    updatedAt: new Date('2026-10-03T12:00:00.000Z'),
  } as UnifiedSession;
  return stripVTControlCharacters(formatSessionForSelect(session, columns));
}

describe('formatSessionForSelect', () => {
  const summary = 'Review the GoodLife daily API automation failures';

  it('shows the whole summary when the terminal is wide enough', () => {
    expect(row(summary, 130)).toContain(summary);
    expect(row(summary, 100).endsWith(`  ${summary.slice(0, 24)}`)).toBe(true);
  });

  it('keeps at least 16 columns of summary on narrow terminals', () => {
    expect(row(summary, 60).endsWith(`  ${summary.slice(0, 16)}`)).toBe(true);
  });

  it('counts CJK characters as two columns', () => {
    expect(row('大家減齡大家減齡大家減齡', 60).endsWith('  大家減齡大家減齡')).toBe(true);
  });
});
