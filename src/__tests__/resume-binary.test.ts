import { describe, expect, it } from 'vitest';
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
});
