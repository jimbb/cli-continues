import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UnifiedSession } from '../types/index.js';

const state = vi.hoisted(() => ({ select: vi.fn(), cancel: vi.fn(), cancelled: Symbol('cancelled') }));

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@clack/prompts')>()),
  select: state.select,
  cancel: state.cancel,
  isCancel: (value: unknown) => value === state.cancelled,
}));
vi.mock('../utils/resume.js', () => ({ getAvailableTools: vi.fn(async () => ['codex', 'claude']) }));

const clack = await import('@clack/prompts');
const { selectTargetTool } = await import('../commands/_shared.js');
const session = { source: 'codex' } as UnifiedSession;

afterEach(() => {
  vi.clearAllMocks();
});

describe('target tool navigation', () => {
  for (const name of ['escape', 'left']) {
    it(`returns back on ${name} and cleans up keyboard handling`, async () => {
      const listeners = process.stdin.listenerCount('keypress');
      const alias = clack.settings.aliases.get('left');
      state.select.mockImplementationOnce(() => {
        process.stdin.emit('keypress', undefined, { name });
        return state.cancelled;
      });

      expect(await selectTargetTool(session)).toBe('back');
      expect(process.stdin.listenerCount('keypress')).toBe(listeners);
      expect(clack.settings.aliases.get('left')).toBe(alias);
      expect(state.cancel).not.toHaveBeenCalled();
    });
  }

  it('offers a visible back option', async () => {
    state.select.mockResolvedValueOnce('back');
    expect(await selectTargetTool(session)).toBe('back');
    expect(state.select.mock.calls[0][0].options).toContainEqual(expect.objectContaining({ value: 'back' }));
  });

  it('keeps Ctrl+C as cancellation', async () => {
    state.select.mockImplementationOnce(() => {
      process.stdin.emit('keypress', '\u0003', { name: 'c', ctrl: true });
      return state.cancelled;
    });
    expect(await selectTargetTool(session)).toBeNull();
    expect(state.cancel).toHaveBeenCalledWith('Cancelled');
  });

  it('restores keyboard handling when prompting fails', async () => {
    const listeners = process.stdin.listenerCount('keypress');
    const alias = clack.settings.aliases.get('left');
    state.select.mockRejectedValueOnce(new Error('prompt failed'));
    await expect(selectTargetTool(session)).rejects.toThrow('prompt failed');
    expect(process.stdin.listenerCount('keypress')).toBe(listeners);
    expect(clack.settings.aliases.get('left')).toBe(alias);
  });
});
