/**
 * Devin CLI parser.
 *
 * Devin CLI stores sessions in a SQLite database (WAL mode) at
 * `~/.local/share/devin/cli/sessions.db` (the `cli-next` install channel keeps
 * its own `sessions.db` sibling). Layout:
 *
 *   sessions       id, working_directory, model, created_at, last_activity_at,
 *                  title, main_chain_id, hidden
 *   message_nodes  conversation tree — node_id/parent_node_id chain per
 *                  session; chat_message is a JSON blob
 *                  { message_id, role: user|assistant|tool|system, content,
 *                  tool_calls[], tool_call_id?, thinking?, metadata }
 *
 * `sessions.main_chain_id` points at the tip of the active conversation
 * branch; walking parent_node_id links to the root yields the chronological
 * transcript. Tool results arrive as separate `role: "tool"` nodes — paired by
 * `tool_call_id` when present (Devin 3000.14+), falling back to positional
 * order against the preceding assistant message's `tool_calls`.
 *
 * Read-only: this parser never writes to the database.
 */
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionEvent,
  SessionNotes,
  SessionParseOptions,
  ToolCall,
  UnifiedSession,
} from '../types/index.js';
import type { DevinChatMessage, DevinMessageNodeRow, DevinToolCall } from '../types/schemas.js';
import { DevinChatMessageSchema, DevinMessageNodeRowSchema, DevinSessionRowSchema } from '../types/schemas.js';
import { classifyToolName, type ToolSampleCategory } from '../types/tool-names.js';
import { isSystemContent } from '../utils/content.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { IS_WINDOWS } from '../utils/platform.js';
import {
  fetchSummary,
  fileSummary,
  globSummary,
  grepSummary,
  mcpSummary,
  SummaryCollector,
  searchSummary,
  shellSummary,
  subagentSummary,
  truncate,
} from '../utils/tool-summarizer.js';

const require = createRequire(import.meta.url);

const DEVIN_SOURCE = 'devin' as const;
const DEVIN_DB_FILE = 'sessions.db';
/** Install channels that keep their own sessions.db, newest-first. */
const DEVIN_INSTALL_DIRS = ['cli', 'cli-next'] as const;
/** Guard against pathological trees when walking the parent chain. */
const MAX_CHAIN_DEPTH = 20_000;

interface SqlitePreparedStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface DatabaseSyncConstructor {
  new (location: string, options?: { readOnly?: boolean }): SqliteDatabase;
}

function getDatabaseSyncConstructor(): DatabaseSyncConstructor | undefined {
  try {
    const sqlite = require('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor };
    return sqlite.DatabaseSync;
  } catch (err) {
    logger.debug('devin: node:sqlite is unavailable', err);
    return undefined;
  }
}

/**
 * Resolve candidate sessions.db paths.
 * `DEVIN_CLI_HOME` overrides the base directory (fixtures, sandboxed installs);
 * otherwise both install channels under the XDG data dir are considered.
 */
function getDevinDbPaths(): string[] {
  if (process.env.DEVIN_CLI_HOME) {
    const overridePath = path.join(process.env.DEVIN_CLI_HOME, DEVIN_DB_FILE);
    return fs.existsSync(overridePath) ? [overridePath] : [];
  }
  const dataRoot = process.env.XDG_DATA_HOME || path.join(homeDir(), '.local', 'share');
  const base = path.join(dataRoot, 'devin');
  return DEVIN_INSTALL_DIRS.map((dir) => path.join(base, dir, DEVIN_DB_FILE)).filter((p) => fs.existsSync(p));
}

function openReadOnlyDatabase(dbPath: string): SqliteDatabase | undefined {
  const DatabaseSync = getDatabaseSyncConstructor();
  if (!DatabaseSync) return undefined;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    logger.debug('devin: failed to open SQLite database read-only', dbPath, err);
    return undefined;
  }
}

function closeDatabase(db: SqliteDatabase, dbPath: string): void {
  try {
    db.close();
  } catch (err) {
    logger.debug('devin: failed to close SQLite database', dbPath, err);
  }
}

function sameCwd(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return IS_WINDOWS ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** Devin stores unix seconds; tolerate millisecond values defensively. */
function normalizeTimestamp(value: number | undefined | null): Date | undefined {
  if (value === undefined || value === null || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseChatMessage(raw: string | null | undefined): DevinChatMessage | undefined {
  if (!raw) return undefined;
  try {
    const result = DevinChatMessageSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : undefined;
  } catch (err) {
    logger.debug('devin: failed to parse chat_message blob', err);
    return undefined;
  }
}

/** Map Devin tool names onto the shared tool categories. */
function classifyDevinToolName(name: string): ToolSampleCategory | undefined {
  switch (name) {
    case 'exec':
      return 'shell';
    case 'find_file_by_name':
      return 'glob';
    case 'run_subagent':
      return 'task';
    default:
      return classifyToolName(name);
  }
}

function extractPatchFilePaths(patch: string): string[] {
  const paths = new Set<string>();
  for (const line of patch.split('\n')) {
    const match =
      line.match(/^\*\*\* (?:Add|Update|Delete) File: ([^\t\r\n]+)/) ||
      line.match(/^[-+]{3}\s+(?:[ab]\/)?([^\t\r\n]+)/);
    if (!match?.[1]) continue;
    const filePath = match[1].trim();
    if (filePath && filePath !== '/dev/null') paths.add(filePath);
  }
  return Array.from(paths);
}

function normalizeToolArguments(raw: DevinToolCall['arguments']): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') return { patch: raw };
  return raw;
}

function extractThinkingText(thinking: DevinChatMessage['thinking']): string {
  if (!thinking) return '';
  if (typeof thinking === 'string') return thinking;
  return thinking.thinking || thinking.text || '';
}

interface DevinSessionQueryRow {
  id: string;
  working_directory: string | undefined;
  model: string | undefined;
  createdAt: Date | undefined;
  updatedAt: Date | undefined;
  title: string;
  messageCount: number;
}

function querySessionRows(db: SqliteDatabase): DevinSessionQueryRow[] {
  let rawRows: unknown[] = [];
  try {
    rawRows = db
      .prepare(
        `SELECT s.id AS id,
                s.working_directory AS working_directory,
                s.model AS model,
                s.created_at AS created_at,
                s.last_activity_at AS last_activity_at,
                s.title AS title,
                COUNT(m.row_id) AS message_count
         FROM sessions s
         LEFT JOIN message_nodes m ON m.session_id = s.id
         WHERE COALESCE(s.hidden, 0) = 0
         GROUP BY s.id
         ORDER BY s.last_activity_at DESC`,
      )
      .all();
  } catch (err) {
    logger.debug('devin: sessions query failed', err);
    return [];
  }

  const rows: DevinSessionQueryRow[] = [];
  for (const raw of rawRows) {
    const result = DevinSessionRowSchema.safeParse(raw);
    if (!result.success) continue;
    const row = result.data;
    const model = row.model?.trim() ? row.model.trim() : undefined;
    rows.push({
      id: row.id,
      working_directory: row.working_directory ?? undefined,
      model,
      createdAt: normalizeTimestamp(row.created_at),
      updatedAt: normalizeTimestamp(row.last_activity_at),
      title: row.title ?? '',
      messageCount:
        typeof (raw as Record<string, unknown>).message_count === 'number'
          ? ((raw as Record<string, unknown>).message_count as number)
          : 0,
    });
  }
  return rows;
}

/** First real user prompt, used when the session title is missing or generic. */
function getFirstUserMessage(db: SqliteDatabase, sessionId: string): string {
  let nodes: unknown[] = [];
  try {
    nodes = db
      .prepare(
        `SELECT chat_message FROM message_nodes
         WHERE session_id = ? ORDER BY node_id LIMIT 25`,
      )
      .all(sessionId);
  } catch (err) {
    logger.debug('devin: first-message lookup failed', sessionId, err);
    return '';
  }
  for (const node of nodes) {
    const chat = parseChatMessage((node as Record<string, unknown>).chat_message as string | undefined);
    if (!chat || chat.role !== 'user') continue;
    const text = (chat.content ?? '').trim();
    if (text && !isSystemContent(text) && isRealUserPrompt(text)) return text;
  }
  return '';
}

function isRealUserPrompt(text: string): boolean {
  return !text.startsWith('<') && !text.startsWith('/') && !text.includes('Session Handoff');
}

const GENERIC_TITLES = new Set(['', 'new session', 'untitled', 'untitled session']);

function listSessionsFromDb(db: SqliteDatabase, dbPath: string, options: SessionParseOptions): UnifiedSession[] {
  const rows = querySessionRows(db);
  const sessions: UnifiedSession[] = [];

  for (const row of rows) {
    if (row.messageCount <= 0) continue;

    const genericTitle = GENERIC_TITLES.has(row.title.trim().toLowerCase());
    const firstUserMessage = genericTitle ? getFirstUserMessage(db, row.id) : '';
    const summary = cleanSummary(genericTitle ? firstUserMessage : row.title || firstUserMessage);
    if (!summary) continue;

    const cwd = row.working_directory ?? '';
    if (options.cwd && (!cwd || !sameCwd(cwd, options.cwd))) continue;

    const createdAt = row.createdAt ?? new Date(0);
    const updatedAt = row.updatedAt ?? createdAt;

    sessions.push({
      id: row.id,
      source: DEVIN_SOURCE,
      cwd,
      ...(cwd ? { repo: extractRepoFromCwd(cwd) } : {}),
      lines: row.messageCount,
      bytes: 0,
      createdAt,
      updatedAt,
      originalPath: dbPath,
      summary,
      ...(row.model ? { model: row.model } : {}),
    });
  }

  return sessions;
}

/**
 * Parse all Devin CLI sessions from every install channel's sessions.db.
 */
export async function parseDevinSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const sessions: UnifiedSession[] = [];

  for (const dbPath of getDevinDbPaths()) {
    const db = openReadOnlyDatabase(dbPath);
    if (!db) continue;
    try {
      sessions.push(...listSessionsFromDb(db, dbPath, options));
    } finally {
      closeDatabase(db, dbPath);
    }
  }

  sessions.sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  return options.limit ? sessions.slice(0, options.limit) : sessions;
}

/**
 * Walk the conversation tree from the session's main chain tip up to the root.
 * Returns nodes in chronological (root → tip) order.
 */
function loadMainChain(db: SqliteDatabase, sessionId: string, mainChainId: number | undefined): DevinMessageNodeRow[] {
  let tip = mainChainId;
  if (tip === undefined) {
    try {
      const fallback = db
        .prepare('SELECT MAX(node_id) AS tip FROM message_nodes WHERE session_id = ?')
        .get(sessionId) as Record<string, unknown> | undefined;
      tip = typeof fallback?.tip === 'number' ? fallback.tip : undefined;
    } catch (err) {
      logger.debug('devin: chain tip lookup failed', sessionId, err);
      return [];
    }
  }
  if (tip === undefined) return [];

  const selectNode = db.prepare(
    `SELECT node_id, parent_node_id, chat_message, created_at
     FROM message_nodes WHERE session_id = ? AND node_id = ?`,
  );

  const chain: DevinMessageNodeRow[] = [];
  const visited = new Set<number>();
  let cursor: number | undefined = tip;

  while (cursor !== undefined && !visited.has(cursor) && chain.length < MAX_CHAIN_DEPTH) {
    visited.add(cursor);
    let raw: unknown;
    try {
      raw = selectNode.get(sessionId, cursor);
    } catch (err) {
      logger.debug('devin: chain node lookup failed', sessionId, cursor, err);
      break;
    }
    const result = DevinMessageNodeRowSchema.safeParse(raw);
    if (!result.success) break;
    const node = result.data;
    chain.push(node);
    cursor = node.parent_node_id ?? undefined;
  }

  return chain.reverse();
}

interface ExtractedDevinConversation {
  messages: ConversationMessage[];
  summaries: ReturnType<SummaryCollector['getSummaries']>;
  filesModified: string[];
  timeline: SessionEvent[];
  model?: string;
  reasoning: string[];
  tokenUsage?: { input: number; output: number };
  cacheTokens?: { read: number; creation: number };
}

function buildConversation(chain: DevinMessageNodeRow[], config: VerbosityConfig): ExtractedDevinConversation {
  const collector = new SummaryCollector(config);
  const messages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  const reasoning: string[] = [];
  const maxHighlights = config.thinking.maxHighlights;
  let sequence = 0;
  let detectedModel: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  /** Unpaired tool calls from the most recent assistant message, in order. */
  let pendingCalls: { call: DevinToolCall; toolCall: ToolCall }[] = [];

  const attachResult = (resultText: string, toolCallId?: string | null): void => {
    if (toolCallId) {
      const idx = pendingCalls.findIndex((entry) => entry.call.id === toolCallId);
      if (idx >= 0) {
        const [matched] = pendingCalls.splice(idx, 1);
        matched.toolCall.result = truncate(resultText, 500);
        return;
      }
    }
    const pending = pendingCalls.shift();
    if (pending) pending.toolCall.result = truncate(resultText, 500);
  };

  for (const node of chain) {
    const chat = parseChatMessage(node.chat_message);
    if (!chat) continue;
    const timestamp = normalizeTimestamp(node.created_at);

    if (chat.metadata) {
      const genModel = chat.metadata.generation_model;
      if (typeof genModel === 'string' && genModel.trim()) {
        detectedModel = genModel.trim();
      }
      const metrics = chat.metadata.metrics as Record<string, unknown> | undefined;
      if (metrics && typeof metrics === 'object') {
        if (typeof metrics.input_tokens === 'number') inputTokens += metrics.input_tokens;
        if (typeof metrics.output_tokens === 'number') outputTokens += metrics.output_tokens;
        if (typeof metrics.cache_read_tokens === 'number') cacheReadTokens += metrics.cache_read_tokens;
        if (typeof metrics.cache_creation_tokens === 'number') cacheCreationTokens += metrics.cache_creation_tokens;
      }
    }

    if (chat.role === 'system') continue;

    if (chat.role === 'user') {
      const text = (chat.content ?? '').trim();
      if (!text || isSystemContent(text)) continue;
      const message: ConversationMessage = { role: 'user', content: text, timestamp };
      messages.push(message);
      timeline.push({ kind: 'message', sequence: sequence++, ...message });
      pendingCalls = [];
      continue;
    }

    if (chat.role === 'tool') {
      const resultText = (chat.content ?? '').trim();
      if (resultText) attachResult(resultText, chat.tool_call_id);
      continue;
    }

    // assistant
    if (reasoning.length < maxHighlights) {
      const thinkingText = extractThinkingText(chat.thinking);
      if (thinkingText.length > 20) {
        const firstLine = thinkingText.split(/[.\n]/)[0]?.trim();
        if (firstLine) reasoning.push(truncate(firstLine, 200));
      }
    }

    const text = (chat.content ?? '').trim();
    const rawToolCalls = chat.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawToolCalls.map((call) => {
      const normalizedArgs = normalizeToolArguments(call.arguments);
      return {
        name: call.name,
        ...(call.id ? { id: call.id } : {}),
        ...(normalizedArgs ? { arguments: normalizedArgs } : {}),
      };
    });

    if (toolCalls.length > 0) {
      const assistantMessage: ConversationMessage = {
        role: 'assistant',
        content: text,
        toolCalls,
        timestamp,
      };
      messages.push(assistantMessage);
      if (text) {
        timeline.push({ kind: 'message', sequence: sequence++, ...assistantMessage });
      }
      pendingCalls = toolCalls.map((toolCall, index) => ({ call: rawToolCalls[index], toolCall }));
      recordToolSummaries(collector, rawToolCalls);
      continue;
    }

    if (!text) continue;
    const assistantMessage: ConversationMessage = { role: 'assistant', content: text, timestamp };
    messages.push(assistantMessage);
    timeline.push({ kind: 'message', sequence: sequence++, ...assistantMessage });
  }

  return {
    messages,
    summaries: collector.getSummaries(),
    filesModified: collector.getFilesModified(),
    timeline,
    ...(detectedModel ? { model: detectedModel } : {}),
    reasoning,
    ...(inputTokens || outputTokens ? { tokenUsage: { input: inputTokens, output: outputTokens } } : {}),
    ...(cacheReadTokens || cacheCreationTokens
      ? { cacheTokens: { read: cacheReadTokens, creation: cacheCreationTokens } }
      : {}),
  };
}

function recordToolSummaries(collector: SummaryCollector, calls: DevinToolCall[]): void {
  for (const call of calls) {
    const category = classifyDevinToolName(call.name);
    if (!category) continue;
    const rawArgs = call.arguments;
    const args: Record<string, unknown> =
      rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {};
    const rawStringArg = typeof rawArgs === 'string' ? rawArgs : '';
    const firstString = (...keys: string[]): string => {
      for (const key of keys) {
        const value = args[key];
        if (typeof value === 'string' && value) return value;
      }
      return '';
    };

    switch (category) {
      case 'shell': {
        const command = firstString('command', 'cmd');
        collector.add(call.name, shellSummary(command), {
          data: { category: 'shell', command },
        });
        break;
      }
      case 'read': {
        const filePath = firstString('file_path', 'path');
        collector.add(call.name, fileSummary('read', filePath || '(unknown file)'), {
          data: { category: 'read', filePath: filePath || '(unknown file)' },
          filePath: filePath || undefined,
        });
        break;
      }
      case 'write': {
        const writePath = firstString('file_path', 'path') || '(unknown file)';
        collector.add(call.name, fileSummary('write', writePath, undefined, true), {
          data: { category: 'write', filePath: writePath, isNewFile: true },
          filePath: writePath,
          isWrite: true,
        });
        break;
      }
      case 'edit': {
        const patchText = rawStringArg || firstString('patch', 'input', 'content');
        const patchFiles = patchText ? extractPatchFilePaths(patchText) : [];
        const editPath = firstString('file_path', 'path') || patchFiles[0] || '(unknown file)';
        collector.add(call.name, fileSummary('edit', editPath), {
          data: { category: 'edit', filePath: editPath },
          filePath: editPath !== '(unknown file)' ? editPath : undefined,
          isWrite: editPath !== '(unknown file)',
        });
        for (const patchFile of patchFiles) collector.trackFile(patchFile);
        break;
      }
      case 'grep': {
        const pattern = firstString('pattern', 'query');
        collector.add(call.name, grepSummary(pattern, firstString('path')), {
          data: { category: 'grep', pattern },
        });
        break;
      }
      case 'glob': {
        const pattern = firstString('pattern', 'glob', 'path');
        collector.add(call.name, globSummary(pattern), {
          data: { category: 'glob', pattern },
        });
        break;
      }
      case 'search': {
        const query = firstString('query', 'search');
        collector.add(call.name, searchSummary(query), {
          data: { category: 'search', query },
        });
        break;
      }
      case 'fetch': {
        const url = firstString('url');
        collector.add(call.name, fetchSummary(url), {
          data: { category: 'fetch', url },
        });
        break;
      }
      case 'task': {
        const description = firstString('task', 'description', 'prompt');
        collector.add(call.name, subagentSummary(description), {
          data: { category: 'task', description },
        });
        break;
      }
      case 'ask': {
        const question = truncate(firstString('question', 'prompt') || JSON.stringify(args.questions ?? ''), 80);
        collector.add(call.name, `ask: "${question}"`, {
          data: { category: 'ask', question },
        });
        break;
      }
      default: {
        if (call.name === 'mcp_call_tool') {
          const serverName = firstString('server_name');
          const toolName = firstString('tool_name');
          const qualified = serverName && toolName ? `${serverName}/${toolName}` : toolName || call.name;
          collector.add(qualified, mcpSummary(qualified, truncate(JSON.stringify(args.arguments ?? {}), 80)));
        } else {
          const displayArgs = rawStringArg ? truncate(rawStringArg, 80) : truncate(JSON.stringify(args), 80);
          collector.add(call.name, mcpSummary(call.name, displayArgs));
        }
        break;
      }
    }
  }
}

function emptyContext(
  session: UnifiedSession,
  config: VerbosityConfig,
  warning: string,
  dbPath: string | undefined,
): SessionContext {
  const sessionNotes: SessionNotes = {
    ...(warning ? { fidelityWarnings: [warning] } : {}),
    ...(dbPath ? { rawAccess: { kind: 'sqlite', path: dbPath } } : {}),
  };
  return {
    session,
    recentMessages: [],
    filesModified: [],
    pendingTasks: [],
    toolSummaries: [],
    sessionNotes,
    markdown: generateHandoffMarkdown(session, [], [], [], [], sessionNotes, config),
  };
}

/**
 * Extract context from a Devin CLI session for cross-tool continuation.
 */
export async function extractDevinContext(session: UnifiedSession, config?: VerbosityConfig): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const dbPath = session.originalPath;
  if (!dbPath || !fs.existsSync(dbPath)) {
    return emptyContext(session, resolvedConfig, 'Devin sessions.db was not found or was unreadable.', dbPath);
  }

  const db = openReadOnlyDatabase(dbPath);
  if (!db) {
    return emptyContext(session, resolvedConfig, 'Devin sessions.db could not be opened.', dbPath);
  }

  try {
    let mainChainId: number | undefined;
    try {
      const row = db.prepare('SELECT main_chain_id FROM sessions WHERE id = ?').get(session.id) as
        | Record<string, unknown>
        | undefined;
      mainChainId = typeof row?.main_chain_id === 'number' ? row.main_chain_id : undefined;
    } catch (err) {
      logger.debug('devin: session lookup failed', session.id, err);
    }

    const chain = loadMainChain(db, session.id, mainChainId);
    if (chain.length === 0) {
      return emptyContext(session, resolvedConfig, 'Devin conversation chain was empty or unreadable.', dbPath);
    }

    const extracted = buildConversation(chain, resolvedConfig);

    // Balanced tail: keep the last N messages but ensure a user message survives.
    const tail = extracted.messages.slice(-resolvedConfig.recentMessages);
    const recentMessages =
      tail.some((m) => m.role === 'user') || extracted.messages.length <= resolvedConfig.recentMessages
        ? tail
        : [...extracted.messages.filter((m) => m.role === 'user').slice(-1), ...tail];

    const resolvedModel = session.model || extracted.model;
    const resolvedSession = resolvedModel && !session.model ? { ...session, model: resolvedModel } : session;
    const sessionNotes: SessionNotes = {
      ...(resolvedModel ? { model: resolvedModel } : {}),
      ...(extracted.reasoning.length > 0 ? { reasoning: extracted.reasoning } : {}),
      ...(extracted.tokenUsage ? { tokenUsage: extracted.tokenUsage } : {}),
      ...(extracted.cacheTokens ? { cacheTokens: extracted.cacheTokens } : {}),
      rawAccess: { kind: 'sqlite', path: dbPath },
    };

    const markdown = generateHandoffMarkdown(
      resolvedSession,
      recentMessages,
      extracted.filesModified,
      [],
      extracted.summaries,
      sessionNotes,
      resolvedConfig,
      'inline',
      extracted.timeline,
    );

    return {
      session: resolvedSession,
      recentMessages,
      filesModified: extracted.filesModified,
      pendingTasks: [],
      toolSummaries: extracted.summaries,
      sessionNotes,
      timeline: extracted.timeline,
      markdown,
    };
  } finally {
    closeDatabase(db, dbPath);
  }
}
