import { describe, expect, it } from 'vitest';
import { activeBranch, toAnthropic } from '../parsers/caveman.js';

describe('caveman (pi v3) parser', () => {
  const entries = [
    { type: 'session', id: 'root-header', cwd: '/tmp' },
    { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'message',
      id: 'abandoned',
      parentId: 'u1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
    },
    {
      type: 'message',
      id: 'a1',
      parentId: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 't1', name: 'read', arguments: { path: 'a.txt' } }],
      },
    },
    {
      type: 'message',
      id: 'r1',
      parentId: 'a1',
      message: { role: 'toolResult', toolCallId: 't1', content: [{ type: 'text', text: 'x' }], isError: false },
    },
  ];

  it('follows the branch ending at the last entry', () => {
    expect(activeBranch(entries as never).map((e) => e.id)).toEqual(['u1', 'a1', 'r1']);
  });

  it('converts tool calls and results to Anthropic blocks', () => {
    const out = toAnthropic(activeBranch(entries as never));
    expect(out[1].content[0]).toEqual({ type: 'tool_use', id: 't1', name: 'read', input: { path: 'a.txt' } });
    expect(out[2]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x', is_error: false }],
    });
  });
});
