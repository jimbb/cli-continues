import { describe, expect, it } from 'vitest';
import { adapters } from '../parsers/registry.js';
import { IS_WINDOWS } from '../utils/platform.js';
import { getToolBinaryCandidates, resolveToolBinaryName } from '../utils/resume.js';

describe('tool binary resolution', () => {
  it('prefers cursor-agent with agent as fallback', () => {
    expect(getToolBinaryCandidates('cursor')).toEqual(['cursor-agent', 'agent']);
  });

  it('chooses cursor-agent when it is available', async () => {
    const binaryName = await resolveToolBinaryName('cursor', async (candidate) => candidate === 'cursor-agent');

    expect(binaryName).toBe('cursor-agent');
  });

  it('falls back to agent when cursor-agent is unavailable', async () => {
    const binaryName = await resolveToolBinaryName('cursor', async (candidate) => candidate === 'agent');

    expect(binaryName).toBe('agent');
  });

  it('returns null when no cursor binary is available', async () => {
    const binaryName = await resolveToolBinaryName('cursor', async () => false);

    expect(binaryName).toBeNull();
  });

  it('prefers agy with antigravity as fallback', async () => {
    expect(getToolBinaryCandidates('antigravity')).toEqual(['agy', 'antigravity']);
    const preferred = await resolveToolBinaryName('antigravity', async (candidate) => candidate === 'agy');
    expect(preferred).toBe('agy');
    const fallback = await resolveToolBinaryName('antigravity', async (candidate) => candidate === 'antigravity');
    expect(fallback).toBe('antigravity');
  });

  it('prefers commandcode for cmd and never falls back to bare cmd on Windows', async () => {
    const candidates = getToolBinaryCandidates('cmd');
    expect(candidates[0]).toBe('commandcode');
    if (IS_WINDOWS) {
      expect(candidates).not.toContain('cmd');
    } else {
      expect(candidates).toContain('cmd');
    }
    const preferred = await resolveToolBinaryName('cmd', async (candidate) => candidate === 'commandcode');
    expect(preferred).toBe('commandcode');
    expect(adapters.cmd.nativeResumeArgs({ id: 'abc' } as Parameters<typeof adapters.cmd.nativeResumeArgs>[0])).toEqual(
      ['--resume', 'abc'],
    );
  });

  it('uses devin binary with -r native resume and -- prompt separator', () => {
    expect(getToolBinaryCandidates('devin')).toEqual(['devin']);
    expect(
      adapters.devin.nativeResumeArgs({ id: 'sess-1' } as Parameters<typeof adapters.devin.nativeResumeArgs>[0]),
    ).toEqual(['-r', 'sess-1']);
    expect(adapters.devin.crossToolArgs('continue work', '/tmp')).toEqual(['--', 'continue work']);
  });
});
