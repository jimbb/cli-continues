import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import {
  decodeDshSlug,
  decompressZstd,
  extractDshContext,
  parseDshSessions,
  resolveDshHome,
  toAnthropic,
} from '../parsers/dsh.js';
import { createDshFixture } from './fixtures/index.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

describe('dsh (DeepSeek Harness v4) parser', () => {
  it('discovers zstd-compressed sessions under DSH_HOME and extracts full context', async () => {
    const fixture = createDshFixture();
    cleanups.push(fixture.cleanup);

    const tuiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dsh-tui-'));
    cleanups.push(() => fs.rmSync(tuiDir, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(tuiDir, 'session-index.json'),
      JSON.stringify({
        version: 4,
        entries: {
          [fixture.sessionId]: {
            branch: 'main',
            derived: {
              title: 'Index title',
              titleSource: 'auto',
              model: 'dsh-deepseek-flash',
            },
          },
        },
      }),
    );

    const sessions = await parseDshSessions({ dshHome: fixture.root, dshTuiDir: tuiDir });
    expect(sessions).toHaveLength(1);
    const session = sessions[0];
    expect(session.id).toBe(fixture.sessionId);
    expect(session.source).toBe('dsh');
    expect(session.cwd).toBe('/home/user/project');
    expect(session.repo).toBe('user/project');
    expect(session.branch).toBe('main');
    expect(session.model).toBe('dsh-deepseek-flash');
    expect(session.summary).toBe('Fix auth token validation in login.ts');
    expect(session.createdAt.getTime()).toBe(1768471200000);
    expect(session.updatedAt.getTime()).toBe(1768471207500);

    const ctx = await extractDshContext(session);
    expect(ctx.recentMessages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'Fix the authentication bug in login.ts' },
      { role: 'assistant', content: 'I found the issue in login.ts and added missing token validation.' },
      { role: 'user', content: 'Great, please also add error handling' },
      { role: 'assistant', content: 'Done. I added error handling and ran the test suite.' },
    ]);

    // Tool calls are deduplicated across assistant/message and tool/call events
    const bashSummary = ctx.toolSummaries.find((t) => t.name === 'Bash');
    const grepSummary = ctx.toolSummaries.find((t) => t.name === 'Grep');
    const writeSummary = ctx.toolSummaries.find((t) => t.name === 'write');
    expect(bashSummary?.count).toBe(1);
    expect(grepSummary?.count).toBe(1);
    expect(writeSummary?.count).toBe(1);

    expect(ctx.filesModified).toContain('/home/user/project/src/login.ts');
    expect(ctx.sessionNotes?.model).toBe('dsh-deepseek-flash');
    expect(ctx.sessionNotes?.compactSummary).toContain('Fixed missing token validation');
    expect(ctx.sessionNotes?.reasoning?.[0]).toContain('Need to inspect login');
    expect(ctx.sessionNotes?.tokenUsage).toEqual({ input: 2500, output: 340 });
    expect(ctx.sessionNotes?.cacheTokens).toEqual({ creation: 50, read: 500 });
    expect(ctx.pendingTasks).toEqual(['Add unit tests for login.ts']);
    expect(ctx.markdown).toContain('DeepSeek Harness');
  });

  it('gracefully skips .zstd sessions when zstdDecompressSync is unavailable', async () => {
    const fixture = createDshFixture();
    cleanups.push(fixture.cleanup);

    expect(decompressZstd(Buffer.from('fake'), null)).toBeNull();

    if (fixture.sessionFile.endsWith('.zstd')) {
      const sessions = await parseDshSessions({
        dshHome: fixture.root,
        dshTuiDir: path.join(fixture.root, 'no-tui'),
        decompressor: null,
      });
      expect(sessions).toEqual([]);
    }
  });

  it('skips delegated child sessions and corrupt files while decoding cwd slug fallback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-dsh-edge-'));
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));

    // Valid plain JSONL without cwd in header -> falls back to slug
    const validDir = path.join(root, 'sessions', '--home-user-demo--', '11111111-2222-4333-8444-555555555555');
    fs.mkdirSync(validDir, { recursive: true });
    fs.writeFileSync(
      path.join(validDir, 'session.v4.jsonl'),
      `${[
        JSON.stringify({
          type: 'session',
          version: 4,
          id: '11111111-2222-4333-8444-555555555555',
          createdAt: 1768471200000,
          delegationDepth: 0,
        }),
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1768471201000,
          data: { content: [{ type: 'text', text: 'Inspect slug fallback' }], source: { kind: 'user' } },
        }),
      ].join('\n')}\n`,
    );

    // Delegated child session -> skipped
    const childDir = path.join(root, 'sessions', '--home-user-demo--', '22222222-2222-4333-8444-555555555555');
    fs.mkdirSync(childDir, { recursive: true });
    fs.writeFileSync(
      path.join(childDir, 'session.v4.jsonl'),
      `${[
        JSON.stringify({
          type: 'session',
          version: 4,
          id: '22222222-2222-4333-8444-555555555555',
          createdAt: 1768471200000,
          delegationDepth: 1,
          parentSession: '11111111-2222-4333-8444-555555555555',
        }),
        JSON.stringify({
          type: 'user/message',
          seq: 1,
          time: 1768471201000,
          data: { content: [{ type: 'text', text: 'Subagent task' }], source: { kind: 'user' } },
        }),
      ].join('\n')}\n`,
    );

    // Corrupt zstd file -> skipped without throwing
    const corruptDir = path.join(root, 'sessions', '--home-user-demo--', '33333333-2222-4333-8444-555555555555');
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, 'session.v4.jsonl.zstd'), Buffer.from('not-valid-zstd'));

    const sessions = await parseDshSessions({ dshHome: root, dshTuiDir: path.join(root, 'no-tui') });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('11111111-2222-4333-8444-555555555555');
    expect(sessions[0].cwd).toBe('/home/user/demo');
    expect(sessions[0].summary).toBe('Inspect slug fallback');
  });

  it('resolves DSH_HOME and decodes DSH cwd slugs', () => {
    expect(resolveDshHome({ DSH_HOME: '/custom/dsh' })).toBe(path.resolve('/custom/dsh'));
    expect(resolveDshHome({ DSH_HOME: '   ' })).toBe(path.join(os.homedir(), '.dsh'));
    expect(resolveDshHome({ DSH_HOME: '~/alt-dsh' })).toBe(path.join(os.homedir(), 'alt-dsh'));
    expect(decodeDshSlug('--tmp-demo--')).toBe('/tmp/demo');
  });

  it('converts standalone tool/call events and normalizes pwsh to bash without double-counting', () => {
    const anthropic = toAnthropic([
      {
        type: 'assistant/message',
        data: {
          message: {
            content: [
              { type: 'reasoning', text: 'Checking directory state before editing.' },
              { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' },
            ],
          },
        },
      },
      {
        type: 'tool/call',
        data: { callId: 'c1', name: 'pwsh', arguments: '{"command":"Get-ChildItem"}' },
      },
      {
        type: 'tool/call',
        data: { callId: 'c2', name: 'read', arguments: '{"file_path":"/home/user/project/README.md"}' },
      },
      {
        type: 'tool/result',
        data: {
          message: {
            toolCallId: 'c2',
            content: [{ type: 'text', text: '# Project' }],
            isError: false,
          },
        },
      },
    ]);

    const toolUses = anthropic.flatMap((m) => m.content.filter((b) => b.type === 'tool_use'));
    expect(toolUses).toHaveLength(2);
    expect(toolUses[0]).toMatchObject({ id: 'c1', name: 'bash', input: { command: 'Get-ChildItem' } });
    expect(toolUses[1]).toMatchObject({ id: 'c2', name: 'read', input: { file_path: '/home/user/project/README.md' } });
  });

  it('keeps zstd roundtrip intact on Node 24+', () => {
    const compress = (zlib as unknown as { zstdCompressSync?: (buf: Buffer) => Buffer }).zstdCompressSync;
    if (typeof compress !== 'function') return;
    const sample = '{"type":"session","version":4,"id":"abc"}\n';
    const roundtrip = decompressZstd(compress(Buffer.from(sample, 'utf8')));
    expect(roundtrip).toBe(sample);
  });
});
