/**
 * Command Code (`cmd`) session parser.
 *
 * Command Code stores transcripts under `~/.commandcode/projects/<slug>/<id>.jsonl`
 * with optional `<id>.meta.json` sidecar files (containing `title`, `model`,
 * `traceIds`, `entrypoint`) and `<id>.checkpoints.jsonl` files (excluded).
 *
 * Supports:
 * - Current v1.93+ JSONL format (`type: "session"` header + `type: "message"` tree
 *   entries with Anthropic content blocks `text`/`thinking`/`tool_use`/`tool_result`
 *   and top-level `model` + `usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`)
 * - Pi-style JSONL transcripts (`type: "message"` with `toolCall`/`toolResult` and `message.usage`)
 * - Legacy direct-message transcripts (`role: "user"|"assistant"|"tool"` with `tool-call`/`tool-result`)
 *
 * Read-only: this parser never writes to `~/.commandcode/`.
 */
import * as fs from 'node:fs';
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
  UnifiedSession,
} from '../types/index.js';
import { isSystemContent } from '../utils/content.js';
import { findFiles, mapConcurrent } from '../utils/fs-helpers.js';
import { getFileStats, readJsonlFile, scanJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import { IS_WINDOWS } from '../utils/platform.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

interface CommandCodeUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

interface CommandCodeBlock {
  type?: string;
  text?: string;
  thinking?: string;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | Array<{ type?: string; text?: string }>;
  is_error?: boolean;
}

interface CommandCodeMessage {
  role?: string;
  content?: string | CommandCodeBlock[];
  model?: string;
  usage?: CommandCodeUsage;
  toolCallId?: string;
  isError?: boolean;
}

interface CommandCodeRecord {
  type?: string;
  version?: number;
  id?: string;
  sessionId?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  role?: string;
  content?: string | CommandCodeBlock[];
  message?: CommandCodeMessage;
  model?: string;
  modelId?: string;
  usage?: CommandCodeUsage;
  summary?: string;
  name?: string;
  gitBranch?: string;
}

interface SidecarMeta {
  model?: string;
  title?: string;
}

const COMMANDCODE_HOME = path.join(homeDir(), '.commandcode');

function projectsDir(): string {
  return path.join(process.env.COMMANDCODE_HOME || COMMANDCODE_HOME, 'projects');
}

function sessionFiles(): string[] {
  return findFiles(projectsDir(), {
    match: (entry) => entry.name.endsWith('.jsonl') && !entry.name.endsWith('.checkpoints.jsonl'),
    maxDepth: 1,
  });
}

function sameCwd(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return IS_WINDOWS ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function recordMessage(record: CommandCodeRecord): CommandCodeMessage | undefined {
  if (record.type === 'message') return record.message;
  if (record.role) return { role: record.role, content: record.content };
  return undefined;
}

function textFromContent(content: CommandCodeMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function inferredCwd(filePath: string, headerCwd?: string): string {
  return headerCwd || cwdFromSlug(path.basename(path.dirname(filePath)));
}

async function readSidecarMeta(filePath: string): Promise<SidecarMeta> {
  const sidecar = filePath.replace(/\.jsonl$/u, '.meta.json');
  try {
    const raw = await fs.promises.readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw) as { model?: unknown; title?: unknown };
    return {
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : undefined,
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title.trim() : undefined,
    };
  } catch (err) {
    logger.debug('cmd: sidecar meta unavailable', sidecar, err);
    return {};
  }
}

async function scanMetadata(
  filePath: string,
  lightweight: boolean,
): Promise<{
  id?: string;
  cwd?: string;
  firstUserMessage: string;
  sessionName?: string;
  metaTitle?: string;
  model?: string;
  branch?: string;
  firstTimestamp?: string;
  lastTimestamp?: string;
}> {
  const sidecar = await readSidecarMeta(filePath);
  let id: string | undefined;
  let cwd: string | undefined;
  let firstUserMessage = '';
  let sessionName: string | undefined;
  let model = sidecar.model;
  let branch: string | undefined;
  let firstTimestamp: string | undefined;
  let lastTimestamp: string | undefined;

  const visitor = (value: unknown): 'continue' => {
    const record = value as CommandCodeRecord;
    if (record.type === 'session') {
      id ||= record.id;
      cwd ||= record.cwd;
    }
    id ||= record.sessionId;
    if (record.timestamp) {
      firstTimestamp ||= record.timestamp;
      lastTimestamp = record.timestamp;
    }
    if (record.type === 'session_info' && record.name) sessionName = record.name;
    if (record.modelId) model = record.modelId;
    else if (record.model) model = record.model;
    branch = record.gitBranch && record.gitBranch !== '-' ? record.gitBranch : branch;
    const message = recordMessage(record);
    if (message?.model) model = message.model;
    if (!firstUserMessage && message?.role === 'user') {
      const text = textFromContent(message.content);
      if (text && !isSystemContent(text)) firstUserMessage = text;
    }
    return 'continue';
  };

  if (lightweight) await scanJsonlHead(filePath, 100, visitor);
  else await scanJsonlFile(filePath, visitor);
  return {
    id,
    cwd,
    firstUserMessage,
    sessionName,
    metaTitle: sidecar.title,
    model,
    branch,
    firstTimestamp,
    lastTimestamp,
  };
}

export async function parseCommandCodeSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const lightweight = options.lightweight === true;
  const parsed = await mapConcurrent(sessionFiles(), 16, async (filePath): Promise<UnifiedSession | null> => {
    try {
      const metadata = await scanMetadata(filePath, lightweight);
      const id = metadata.id || path.basename(filePath, '.jsonl');
      const cwd = inferredCwd(filePath, metadata.cwd);
      if (options.cwd && !sameCwd(cwd, options.cwd)) return null;
      const stat = await fs.promises.stat(filePath);
      const stats = lightweight ? { lines: 0, bytes: stat.size } : await getFileStats(filePath);
      const summary =
        metadata.sessionName ||
        (metadata.metaTitle ? cleanSummary(metadata.metaTitle) : undefined) ||
        cleanSummary(metadata.firstUserMessage) ||
        undefined;
      return {
        id,
        source: 'cmd',
        cwd,
        repo: extractRepoFromCwd(cwd),
        branch: metadata.branch,
        summary,
        lines: stats.lines,
        bytes: stat.size,
        createdAt: metadata.firstTimestamp ? new Date(metadata.firstTimestamp) : stat.birthtime,
        updatedAt: metadata.lastTimestamp ? new Date(metadata.lastTimestamp) : stat.mtime,
        originalPath: filePath,
        model: metadata.model,
      };
    } catch (err) {
      logger.debug('cmd: skipping unparseable session', filePath, err);
      return null;
    }
  });

  const sessions = parsed
    .filter((session): session is UnifiedSession => session !== null)
    .filter((session) => lightweight || session.lines > 1)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());

  return options.limit ? sessions.slice(0, options.limit) : sessions;
}

export async function extractCommandCodeContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const allRecords = await readJsonlFile<CommandCodeRecord>(session.originalPath);
  const records = activeBranch(allRecords);
  const anthropicMessages = toAnthropicMessages(records);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropicMessages, resolvedConfig);
  const sessionNotes = extractNotes(records, session.originalPath, session.model, anthropicMessages, resolvedConfig);
  const recentMessages: ConversationMessage[] = [];
  const timeline: SessionEvent[] = [];
  let sequence = 0;

  for (const record of records) {
    const message = recordMessage(record);
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = textFromContent(message.content);
    if (!text || isSystemContent(text)) continue;
    const normalized: ConversationMessage = {
      role: message.role,
      content: text,
      timestamp: record.timestamp ? new Date(record.timestamp) : undefined,
      sourceId: record.id,
      sourceParentId: record.parentId ?? undefined,
    };
    recentMessages.push(normalized);
    timeline.push({ kind: 'message', sequence: sequence++, ...normalized });
  }

  // Balanced tail: keep the last N messages while ensuring at least one user message survives.
  const tail = recentMessages.slice(-resolvedConfig.recentMessages);
  const trimmed =
    tail.some((m) => m.role === 'user') || recentMessages.length <= resolvedConfig.recentMessages
      ? tail
      : [...recentMessages.filter((m) => m.role === 'user').slice(-1), ...tail];

  const resolvedSession = sessionNotes.model ? { ...session, model: sessionNotes.model } : session;
  const markdown = generateHandoffMarkdown(
    resolvedSession,
    trimmed,
    filesModified,
    [],
    toolSummaries,
    sessionNotes,
    resolvedConfig,
    'inline',
    timeline,
  );
  return {
    session: resolvedSession,
    recentMessages: trimmed,
    filesModified,
    pendingTasks: [],
    toolSummaries,
    sessionNotes,
    timeline,
    markdown,
  };
}

function activeBranch(records: CommandCodeRecord[]): CommandCodeRecord[] {
  const treeRecords = records.filter((record) => record.type !== 'session' && record.id);
  if (!treeRecords.some((record) => record.parentId !== undefined)) return records.filter((record) => record.role);
  const byId = new Map(treeRecords.map((record) => [record.id as string, record]));
  const branch: CommandCodeRecord[] = [];
  let current: CommandCodeRecord | undefined = treeRecords.at(-1);
  const visited = new Set<string>();
  while (current?.id && !visited.has(current.id)) {
    visited.add(current.id);
    branch.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function stringifyToolOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output && typeof output === 'object' && 'value' in output) {
    const value = (output as { value?: unknown }).value;
    if (typeof value === 'string') return value;
  }
  try {
    return output === undefined ? '' : JSON.stringify(output);
  } catch (err) {
    logger.debug('cmd: failed to stringify tool output', err);
    return String(output ?? '');
  }
}

function toAnthropicMessages(records: CommandCodeRecord[]): AnthropicMessage[] {
  return records.flatMap((record) => {
    const message = recordMessage(record);
    if (!message) return [];
    if (record.role === 'tool') {
      const blocks = Array.isArray(record.content) ? record.content : [];
      return [
        {
          role: 'user',
          content: blocks
            .filter((block) => block.type === 'tool-result')
            .map((block) => ({
              type: 'tool_result',
              tool_use_id: block.toolCallId || '',
              content: stringifyToolOutput(block.output),
            })),
        } as AnthropicMessage,
      ];
    }
    if (message.role === 'toolResult') {
      return [
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: message.toolCallId || '',
              content: textFromContent(message.content),
              is_error: message.isError,
            },
          ],
        } as AnthropicMessage,
      ];
    }
    const content = Array.isArray(message.content)
      ? message.content.map((block) => {
          if (block.type === 'tool-call') {
            return {
              type: 'tool_use',
              id: block.toolCallId || '',
              name: block.toolName || '',
              input: block.input || {},
            };
          }
          if (block.type === 'toolCall') {
            return {
              type: 'tool_use',
              id: block.id || '',
              name: block.name || '',
              input: block.arguments || {},
            };
          }
          return block.type === 'reasoning' ? { type: 'thinking', thinking: block.text || '' } : block;
        })
      : message.content;
    return [{ role: message.role || 'user', content } as AnthropicMessage];
  });
}

function addUsage(
  totals: { input: number; output: number; cacheRead: number; cacheWrite: number },
  usage: CommandCodeUsage | undefined,
): void {
  if (!usage) return;
  totals.input += usage.input ?? usage.inputTokens ?? 0;
  totals.output += usage.output ?? usage.outputTokens ?? 0;
  totals.cacheRead += usage.cacheRead ?? usage.cacheReadTokens ?? 0;
  totals.cacheWrite += usage.cacheWrite ?? usage.cacheWriteTokens ?? 0;
}

function extractNotes(
  records: CommandCodeRecord[],
  originalPath: string,
  fallbackModel: string | undefined,
  anthropicMessages: AnthropicMessage[],
  config: VerbosityConfig,
): SessionNotes {
  const notes: SessionNotes = { model: fallbackModel, rawAccess: { kind: 'file', path: originalPath } };
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const record of records) {
    if (record.modelId) notes.model = record.modelId;
    else if (record.model) notes.model = record.model;
    if (record.type === 'compaction' && record.summary) notes.compactSummary = truncate(record.summary, 500);
    addUsage(totals, record.usage);
    const message = recordMessage(record);
    if (!message) continue;
    notes.model = message.model || notes.model;
    // Only add message.usage when record.usage wasn't already present on the same record
    if (!record.usage) addUsage(totals, message.usage);
  }
  if (totals.input || totals.output) notes.tokenUsage = { input: totals.input, output: totals.output };
  if (totals.cacheRead || totals.cacheWrite) {
    notes.cacheTokens = { read: totals.cacheRead, creation: totals.cacheWrite };
  }
  const reasoning = extractThinkingHighlights(anthropicMessages, undefined, config);
  if (reasoning.length > 0) notes.reasoning = reasoning;
  return notes;
}
