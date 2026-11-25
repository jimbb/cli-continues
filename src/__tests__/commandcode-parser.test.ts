import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const tmpDirs: string[] = [];

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'commandcode-parser-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJsonl(filePath: string, rows: unknown[]): string {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
  return filePath;
}

async function loadParser(home: string) {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  vi.stubEnv('COMMANDCODE_HOME', path.join(home, '.commandcode'));
  return import('../parsers/commandcode.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  tmpDirs.length = 0;
});

describe('Command Code parser', () => {
  it('discovers and extracts v1.93+ transcripts with top-level model, usage, Anthropic blocks, and meta.json title', async () => {
    const home = makeHome();
    const id = '33333333-3333-4333-8333-333333333333';
    const projDir = path.join(home, '.commandcode', 'projects', 'home-user-app');
    const sessionPath = writeJsonl(path.join(projDir, `${id}.jsonl`), [
      { type: 'session', version: 1, id, cwd: '/home/user/app', timestamp: '2026-11-17T12:00:00.000Z' },
      {
        type: 'message',
        id: 'u1',
        parentId: null,
        timestamp: '2026-11-17T12:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'Update indexnow endpoint' }] },
      },
      {
        type: 'message',
        id: 'a1',
        parentId: 'u1',
        timestamp: '2026-11-17T12:00:02.000Z',
        model: 'deepseek/deepseek-v4.1-flash',
        usage: { inputTokens: 2000, outputTokens: 150, cacheReadTokens: 1200, cacheWriteTokens: 50 },
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Checking directory layout before editing the endpoint handler.' },
            { type: 'text', text: 'Reading the project directory and updating the file.' },
            { type: 'tool_use', id: 'call_dir', name: 'read_directory', input: { path: '/home/user/app/src' } },
            {
              type: 'tool_use',
              id: 'call_edit',
              name: 'edit_file',
              input: { file_path: '/home/user/app/src/indexnow.ts', old_string: 'v1', new_string: 'v2' },
            },
          ],
        },
      },
      {
        type: 'message',
        id: 'tr1',
        parentId: 'a1',
        timestamp: '2026-11-17T12:00:03.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_dir', content: [{ type: 'text', text: 'indexnow.ts' }] },
            { type: 'tool_result', tool_use_id: 'call_edit', content: [{ type: 'text', text: 'Edited 1 file' }] },
          ],
        },
      },
    ]);
    fs.writeFileSync(
      sessionPath.replace(/\.jsonl$/u, '.meta.json'),
      JSON.stringify({ title: 'IndexNow Branch', traceIds: ['t1'] }),
    );
    // Checkpoints file must be excluded from session discovery.
    writeJsonl(path.join(projDir, `${id}.checkpoints.jsonl`), [{ id: 'cp-1', turnNumber: 1 }]);

    const { extractCommandCodeContext, parseCommandCodeSessions } = await loadParser(home);
    const sessions = await parseCommandCodeSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id,
      source: 'cmd',
      cwd: '/home/user/app',
      summary: 'IndexNow Branch',
      model: 'deepseek/deepseek-v4.1-flash',
    });

    const context = await extractCommandCodeContext(sessions[0]);
    // Tool-result-only user message is skipped from recentMessages.
    expect(context.recentMessages.map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'Update indexnow endpoint' },
      { role: 'assistant', content: 'Reading the project directory and updating the file.' },
    ]);
    expect(context.filesModified).toEqual(['/home/user/app/src/indexnow.ts']);
    expect(context.toolSummaries.map((s) => s.name)).toEqual(expect.arrayContaining(['Glob', 'edit_file']));
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 2000, output: 150 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ read: 1200, creation: 50 });
    expect(context.sessionNotes?.reasoning?.[0]).toContain('Checking directory layout');
    expect(context.markdown).toContain('Command Code');
  });

  it('discovers and extracts legacy direct-message transcripts', async () => {
    const home = makeHome();
    const id = '11111111-1111-4111-8111-111111111111';
    const sessionPath = writeJsonl(path.join(home, '.commandcode', 'projects', 'tmp-project', `${id}.jsonl`), [
      {
        id: 'user-1',
        parentId: null,
        sessionId: id,
        role: 'user',
        timestamp: '2026-08-01T10:00:00.000Z',
        content: [{ type: 'text', text: 'Add CommandCode support' }],
      },
      {
        id: 'assistant-1',
        parentId: 'user-1',
        sessionId: id,
        role: 'assistant',
        timestamp: '2026-08-01T10:00:01.000Z',
        content: [
          { type: 'text', text: 'Implementing support.' },
          {
            type: 'tool-call',
            toolCallId: 'call-1',
            toolName: 'write_file',
            input: { path: '/tmp/project/cmd.ts', content: 'export const cmd = true;' },
          },
        ],
      },
      {
        id: 'tool-1',
        parentId: 'assistant-1',
        sessionId: id,
        role: 'tool',
        timestamp: '2026-08-01T10:00:02.000Z',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'write_file',
            output: { type: 'text', value: 'Created /tmp/project/cmd.ts' },
          },
        ],
      },
    ]);
    fs.writeFileSync(sessionPath.replace(/\.jsonl$/u, '.meta.json'), JSON.stringify({ model: 'gpt-5.6' }));
    const { extractCommandCodeContext, parseCommandCodeSessions } = await loadParser(home);

    const [session] = await parseCommandCodeSessions();
    const context = await extractCommandCodeContext(session);

    expect(session).toMatchObject({ id, source: 'cmd', cwd: '/tmp/project', model: 'gpt-5.6' });
    expect(context.recentMessages.map((message) => message.content)).toEqual([
      'Add CommandCode support',
      'Implementing support.',
    ]);
    expect(context.filesModified).toEqual(['/tmp/project/cmd.ts']);
  });

  it('supports Pi-style CommandCode transcripts and filters by cwd', async () => {
    const home = makeHome();
    const id = '22222222-2222-4222-8222-222222222222';
    writeJsonl(path.join(home, '.commandcode', 'projects', 'tmp-project', `${id}.jsonl`), [
      { type: 'session', version: 3, id, cwd: '/tmp/project', timestamp: '2026-08-02T10:00:00.000Z' },
      {
        type: 'message',
        id: 'user-1',
        parentId: null,
        timestamp: '2026-08-02T10:00:01.000Z',
        message: { role: 'user', content: [{ type: 'text', text: 'New format' }] },
      },
      {
        type: 'message',
        id: 'assistant-1',
        parentId: 'user-1',
        timestamp: '2026-08-02T10:00:02.000Z',
        message: { role: 'assistant', model: 'claude-opus', content: [{ type: 'text', text: 'Supported.' }] },
      },
    ]);
    const { extractCommandCodeContext, parseCommandCodeSessions } = await loadParser(home);

    expect(await parseCommandCodeSessions({ cwd: '/tmp/other' })).toHaveLength(0);
    const [session] = await parseCommandCodeSessions({ cwd: '/tmp/project' });
    const context = await extractCommandCodeContext(session);

    expect(session).toMatchObject({ id, cwd: '/tmp/project', model: 'claude-opus', summary: 'New format' });
    expect(context.recentMessages.map((message) => message.content)).toEqual(['New format', 'Supported.']);
  });
});
