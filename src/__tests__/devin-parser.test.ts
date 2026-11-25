import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDevinFixture, type FixtureDir } from './fixtures/index.js';

const require = createRequire(import.meta.url);

const tmpDirs: string[] = [];
let fixture: FixtureDir | undefined;

function makeHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devin-parser-'));
  tmpDirs.push(dir);
  return dir;
}

async function loadDevinParser(
  home: string,
  options?: { envOverride?: boolean },
): Promise<typeof import('../parsers/devin.js')> {
  vi.resetModules();
  vi.stubEnv('HOME', home);
  if (options?.envOverride !== false) {
    vi.stubEnv('DEVIN_CLI_HOME', path.join(home, '.local', 'share', 'devin', 'cli'));
  }
  return import('../parsers/devin.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
  fixture?.cleanup();
  fixture = undefined;
});

/** Copy the shared fixture DB into the given install channel directory. */
function installFixtureDb(home: string, channel: string, hidden = false): string {
  if (!fixture) fixture = createDevinFixture();
  const dbPath = path.join(fixture.root, 'sessions.db');
  const targetDir = path.join(home, '.local', 'share', 'devin', channel);
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, 'sessions.db');
  fs.copyFileSync(dbPath, target);
  if (hidden) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(target);
    db.prepare('UPDATE sessions SET hidden = 1').run();
    db.close();
  }
  return target;
}

describe('devin parser', () => {
  it('discovers sessions from the cli install channel', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli');

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].id).toBe('test-devin-session-1');
    expect(sessions[0].source).toBe('devin');
    expect(sessions[0].cwd).toBe('/home/user/project');
    expect(sessions[0].repo).toBe('user/project');
    expect(sessions[0].summary).toBe('Fix auth bug');
    expect(sessions[0].model).toBe('claude-opus-4-6');
    expect(sessions[0].lines).toBe(8);
    // Unix-second timestamps are interpreted correctly.
    expect(sessions[0].updatedAt.toISOString()).toBe(new Date(1_734_000_040 * 1000).toISOString());
  });

  it('merges sessions from both install channels', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli');
    installFixtureDb(home, 'cli-next');

    const { parseDevinSessions } = await loadDevinParser(home, { envOverride: false });
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(2);
  });

  it('skips hidden sessions', async () => {
    const home = makeHome();
    installFixtureDb(home, 'cli', true);

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(0);
  });

  it('falls back to the first user prompt when the title is empty or NULL', async () => {
    const home = makeHome();
    const dbPath = installFixtureDb(home, 'cli');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    db.prepare('UPDATE sessions SET title = NULL').run();
    db.close();

    const { parseDevinSessions } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();

    expect(sessions).toHaveLength(1);
    expect(sessions[0].summary).toContain('Fix the authentication bug');
  });

  it('extracts conversation, tool calls, thinking, token usage, and modified files from the main chain', async () => {
    const home = makeHome();
    const dbPath = installFixtureDb(home, 'cli');

    const { parseDevinSessions, extractDevinContext } = await loadDevinParser(home);
    const sessions = await parseDevinSessions();
    const context = await extractDevinContext(sessions[0]);

    const userMsgs = context.recentMessages.filter((m) => m.role === 'user');
    const asstMsgs = context.recentMessages.filter((m) => m.role === 'assistant');
    expect(userMsgs).toHaveLength(2);
    expect(asstMsgs).toHaveLength(3);
    expect(userMsgs[0].content).toContain('Fix the authentication bug');
    expect(asstMsgs[2].content).toContain('try-catch');

    // Tool calls are captured with their results paired via tool_call_id.
    const readCall = asstMsgs[0].toolCalls?.[0];
    expect(readCall?.name).toBe('read');
    expect(readCall?.result).toContain('export function login()');

    const editCall = asstMsgs[1].toolCalls?.[0];
    expect(editCall?.name).toBe('edit');
    expect(editCall?.result).toContain('File edited successfully');

    // Tool activity summaries + file tracking.
    const summaryNames = context.toolSummaries.map((s) => s.name);
    expect(summaryNames).toContain('read');
    expect(summaryNames).toContain('edit');
    expect(context.filesModified).toContain('/home/user/project/login.ts');

    // Thinking + token metrics from Devin 3000.14 metadata.
    expect(context.sessionNotes?.reasoning?.[0]).toContain('Checking login');
    expect(context.sessionNotes?.tokenUsage).toEqual({ input: 1200, output: 180 });
    expect(context.sessionNotes?.cacheTokens).toEqual({ read: 600, creation: 100 });

    // Markdown handoff renders with the Devin label and raw access note.
    expect(context.markdown).toContain('Devin CLI');
    expect(context.sessionNotes?.rawAccess).toEqual({ kind: 'sqlite', path: dbPath });
  });

  it('handles Devin 3000.14 apply_patch string arguments, out-of-order tool_call_id, and empty sessions.model', async () => {
    const home = makeHome();
    const dbPath = installFixtureDb(home, 'cli');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath);
    // Simulate Devin 3000.14 session with empty model column and apply_patch string arguments.
    db.prepare('UPDATE sessions SET model = ?, main_chain_id = 12 WHERE id = ?').run('', 'test-devin-session-1');
    const insertNode = db.prepare(
      `INSERT INTO message_nodes (session_id, node_id, parent_node_id, chat_message, created_at, metadata)
       VALUES ('test-devin-session-1', ?, ?, ?, ?, NULL)`,
    );
    insertNode.run(
      9,
      8,
      JSON.stringify({
        message_id: 'm9',
        role: 'assistant',
        content: 'Applying patch and running tests.',
        tool_calls: [
          {
            id: 'call_patch',
            name: 'apply_patch',
            arguments: '*** Begin Patch\n*** Add File: /home/user/project/docs/notes.md\n+# Notes\n*** End Patch',
            index: 0,
            kind: 'function',
          },
          {
            id: 'call_exec',
            name: 'exec',
            arguments: { command: 'npm test' },
            index: 1,
            kind: 'function',
          },
        ],
        metadata: { generation_model: 'gpt-6-2-astra-xhigh' },
      }),
      1_734_000_050,
    );
    // Return tool results out of order to verify tool_call_id matching.
    insertNode.run(
      10,
      9,
      JSON.stringify({ message_id: 'm10', role: 'tool', tool_call_id: 'call_exec', content: 'All tests passed' }),
      1_734_000_051,
    );
    insertNode.run(
      11,
      10,
      JSON.stringify({ message_id: 'm11', role: 'tool', tool_call_id: 'call_patch', content: 'Patch applied' }),
      1_734_000_052,
    );
    insertNode.run(
      12,
      11,
      JSON.stringify({ message_id: 'm12', role: 'assistant', content: 'Patched docs/notes.md and verified tests.' }),
      1_734_000_053,
    );
    db.close();

    const { parseDevinSessions, extractDevinContext } = await loadDevinParser(home);
    const [session] = await parseDevinSessions();
    expect(session.model).toBeUndefined();

    const context = await extractDevinContext(session);
    expect(context.session.model).toBe('gpt-6-2-astra-xhigh');
    expect(context.filesModified).toContain('/home/user/project/docs/notes.md');

    const patchMsg = context.recentMessages.find((m) => m.toolCalls?.some((tc) => tc.name === 'apply_patch'));
    expect(patchMsg).toBeDefined();
    const patchCall = patchMsg?.toolCalls?.find((tc) => tc.id === 'call_patch');
    const execCall = patchMsg?.toolCalls?.find((tc) => tc.id === 'call_exec');
    expect(patchCall?.result).toBe('Patch applied');
    expect(execCall?.result).toBe('All tests passed');
  });

  it('returns an empty context when the database is missing', async () => {
    const home = makeHome();
    const { extractDevinContext } = await loadDevinParser(home);

    const context = await extractDevinContext({
      id: 'missing',
      source: 'devin',
      cwd: '/tmp',
      lines: 0,
      bytes: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      originalPath: path.join(home, 'does-not-exist.db'),
    });

    expect(context.recentMessages).toEqual([]);
    expect(context.sessionNotes?.fidelityWarnings).toHaveLength(1);
  });
});
