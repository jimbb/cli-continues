import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  SessionParseOptions,
  UnifiedSession,
} from '../types/index.js';
import { isSystemContent } from '../utils/content.js';
import { findFiles } from '../utils/fs-helpers.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { cwdFromSlug } from '../utils/slug.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

/**
 * DeepSeek Harness (`dsh` / `dsh-tui`): v4 session JSONL (zstd-compressed) under
 * `$DSH_HOME/sessions/<cwd-slug>/<uuid>/session.v4.jsonl.zstd` (default `~/.dsh`),
 * with optional UI metadata cache in `~/.dsh-tui/session-index.json`.
 */

const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;

export type DshContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
};

export interface DshEvent {
  type: string;
  version?: number;
  id?: string;
  createdAt?: number;
  cwd?: string;
  isSeeded?: boolean;
  delegationDepth?: number;
  parentSession?: string;
  agentPreset?: string;
  seq?: number;
  time?: number;
  data?: Record<string, unknown>;
}

export interface DshTuiIndexEntry {
  title?: string;
  titleSource?: string;
  model?: string;
  modifiedAt?: number;
  branch?: string;
}

type ZstdDecompressor = (input: Buffer) => Buffer;

let warnedNoZstd = false;

function getNativeZstdDecompressor(): ZstdDecompressor | undefined {
  const fn = (zlib as unknown as { zstdDecompressSync?: ZstdDecompressor }).zstdDecompressSync;
  return typeof fn === 'function' ? fn : undefined;
}

/**
 * Decompress a zstd buffer using Node's built-in `zlib.zstdDecompressSync` (Node 24+).
 * Returns `null` on older Node runtimes lacking zstd support instead of crashing.
 */
export function decompressZstd(buf: Buffer, decompressor?: ZstdDecompressor | null): string | null {
  const fn = decompressor === undefined ? getNativeZstdDecompressor() : decompressor;
  if (typeof fn !== 'function') {
    if (!warnedNoZstd) {
      warnedNoZstd = true;
      logger.debug('dsh: zlib.zstdDecompressSync unavailable on this Node version; skipping .zstd sessions');
    }
    return null;
  }
  return fn(buf).toString('utf8');
}

/**
 * Resolve DeepSeek Harness home following `@deepseek-ai/dsh-home-paths`:
 * `$DSH_HOME` (ignoring empty/whitespace-only values, expanding leading `~`), else `~/.dsh`.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME?.trim();
  if (!raw) return path.join(homeDir(), '.dsh');
  if (raw === '~') return homeDir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.join(homeDir(), raw.slice(2));
  }
  return path.resolve(raw);
}

/**
 * Decode a DSH cwd slug directory name (e.g. `--home-user-project--`) into a path.
 * Mirrors the encoder in `@deepseek-ai/dsh-session-persistence-jsonl`.
 */
export function decodeDshSlug(slug: string): string {
  if (!slug) return '';
  let trimmed = slug;
  if (trimmed.startsWith('--')) trimmed = trimmed.slice(2);
  if (trimmed.endsWith('--')) trimmed = trimmed.slice(0, -2);
  if (!trimmed) return '';
  const unescaped = trimmed.replace(/~([0-9A-Fa-f]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return cwdFromSlug(unescaped);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is DshContentBlock => Boolean(b && typeof b === 'object'))
    .filter((b) => b.type === 'text' && typeof b.text === 'string' && b.text.length > 0)
    .map((b) => b.text as string)
    .join('\n');
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return {};
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      return { value: parsed };
    } catch {
      return { raw: trimmed };
    }
  }
  return {};
}

function normalizeDshToolName(name: string): string {
  if (name === 'pwsh') return 'bash';
  return name;
}

function isUserPromptEvent(event: DshEvent): boolean {
  if (event.type !== 'user/message' || !event.data) return false;
  const source = event.data.source as { kind?: string } | undefined;
  if (source?.kind) return source.kind === 'user';
  const text = textOf(event.data.content).trim();
  return Boolean(text) && !isSystemContent(text);
}

/**
 * Read and parse a DSH session file (`.jsonl.zstd` or plain `.jsonl`).
 * Returns `null` when `.zstd` cannot be decompressed on the current Node runtime.
 */
export async function readDshEvents(
  filePath: string,
  decompressor?: ZstdDecompressor | null,
): Promise<DshEvent[] | null> {
  const buf = await fs.readFile(filePath);
  const rawText = filePath.endsWith('.zstd') ? decompressZstd(buf, decompressor) : buf.toString('utf8');
  if (rawText === null) return null;

  const events: DshEvent[] = [];
  for (const line of rawText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as DshEvent;
      if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') {
        events.push(parsed);
      }
    } catch (err) {
      logger.debug('dsh: skipping malformed jsonl line', filePath, err);
    }
  }
  return events;
}

/**
 * Best-effort read of `~/.dsh-tui/session-index.json` for title/model/branch enrichment.
 */
export async function readDshTuiIndex(tuiDir?: string): Promise<Map<string, DshTuiIndexEntry>> {
  const indexPath = path.join(tuiDir ?? path.join(homeDir(), '.dsh-tui'), 'session-index.json');
  const map = new Map<string, DshTuiIndexEntry>();
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw) as { entries?: Record<string, unknown> };
    if (!parsed?.entries || typeof parsed.entries !== 'object') return map;
    for (const [id, entry] of Object.entries(parsed.entries)) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as {
        branch?: unknown;
        derived?: { title?: unknown; titleSource?: unknown; model?: unknown; modifiedAt?: unknown };
      };
      const derived = rec.derived && typeof rec.derived === 'object' ? rec.derived : undefined;
      map.set(id, {
        title: typeof derived?.title === 'string' ? derived.title : undefined,
        titleSource: typeof derived?.titleSource === 'string' ? derived.titleSource : undefined,
        model: typeof derived?.model === 'string' ? derived.model : undefined,
        modifiedAt: typeof derived?.modifiedAt === 'number' ? derived.modifiedAt : undefined,
        branch: typeof rec.branch === 'string' ? rec.branch : undefined,
      });
    }
  } catch (err) {
    logger.debug('dsh: session-index.json unavailable', indexPath, err);
  }
  return map;
}

/**
 * Convert DSH v4 events into Anthropic-style messages for the shared tool extractor
 * and thinking highlighter. Deduplicates `tool/call` events against `tool-call` blocks
 * already embedded inside `assistant/message`.
 */
export function toAnthropic(events: DshEvent[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  const seenToolCallIds = new Set<string>();

  for (const event of events) {
    const data = event.data;
    if (!data) continue;

    if (event.type === 'user/message') {
      if (!isUserPromptEvent(event)) continue;
      const text = textOf(data.content).trim();
      if (text) {
        out.push({ role: 'user', content: [{ type: 'text', text }] });
      }
      continue;
    }

    if (event.type === 'assistant/message') {
      const msg = data.message as { content?: unknown } | undefined;
      const rawBlocks = Array.isArray(msg?.content) ? (msg.content as DshContentBlock[]) : [];
      const blocks: Array<{ type: string; [key: string]: unknown }> = [];
      for (const b of rawBlocks) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.length > 0) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.length > 0) {
          blocks.push({ type: 'thinking', thinking: b.text });
        } else if (b.type === 'tool-call' && typeof b.name === 'string') {
          if (typeof b.id === 'string' && b.id.length > 0) {
            seenToolCallIds.add(b.id);
          }
          blocks.push({
            type: 'tool_use',
            id: typeof b.id === 'string' ? b.id : undefined,
            name: normalizeDshToolName(b.name),
            input: parseToolArguments(b.arguments),
          });
        }
      }
      if (blocks.length > 0) {
        out.push({ role: 'assistant', content: blocks });
      }
      continue;
    }

    if (event.type === 'tool/call') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      const name = typeof data.name === 'string' ? data.name : '';
      if (!name || (callId && seenToolCallIds.has(callId))) continue;
      if (callId) seenToolCallIds.add(callId);
      out.push({
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: callId,
            name: normalizeDshToolName(name),
            input: parseToolArguments(data.arguments),
          },
        ],
      });
      continue;
    }

    if (event.type === 'tool/result') {
      const msg = data.message as
        | { toolCallId?: string; source?: { callId?: string }; content?: unknown; isError?: boolean }
        | undefined;
      const toolCallId = msg?.toolCallId ?? msg?.source?.callId;
      if (!toolCallId) continue;
      out.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: textOf(msg?.content),
            is_error: Boolean(msg?.isError || data.error),
          },
        ],
      });
    }
  }

  return out;
}

function extractTitleFromEvents(events: DshEvent[], indexEntry?: DshTuiIndexEntry): string | undefined {
  let primaryTitle: string | undefined;
  let fallbackTitle: string | undefined;
  let firstUserText = '';

  for (const event of events) {
    if (event.type === 'session/title' && event.data && typeof event.data.title === 'string') {
      const title = event.data.title.trim();
      if (!title) continue;
      const source = event.data.source as { kind?: string } | undefined;
      if (source?.kind === 'fallback') {
        fallbackTitle = title;
      } else {
        primaryTitle = title;
      }
    } else if (!firstUserText && isUserPromptEvent(event)) {
      firstUserText = textOf(event.data?.content).trim();
    }
  }

  const indexPrimary = indexEntry?.title && indexEntry.titleSource !== 'fallback' ? indexEntry.title : undefined;
  const chosen = primaryTitle ?? indexPrimary ?? fallbackTitle ?? firstUserText ?? indexEntry?.title ?? '';
  return cleanSummary(chosen) || undefined;
}

function extractModelFromEvents(events: DshEvent[], fallbackModel?: string): string | undefined {
  let model: string | undefined;
  for (const event of events) {
    if (event.type === 'model/selection' && event.data && typeof event.data.model === 'string') {
      model = event.data.model;
    } else if (event.type === 'assistant/message' && event.data) {
      const msg = event.data.message as { source?: { model?: string } } | undefined;
      if (typeof msg?.source?.model === 'string' && msg.source.model) {
        model = msg.source.model;
      }
    }
  }
  return model ?? fallbackModel;
}

function extractCwdFromEvents(events: DshEvent[], filePath: string): string {
  const header = events[0];
  let cwd = typeof header?.cwd === 'string' ? header.cwd : '';
  for (const event of events) {
    if (event.type === 'working-directory/change' && event.data && typeof event.data.cwd === 'string') {
      cwd = event.data.cwd;
    }
  }
  if (cwd) return cwd;
  // Layout: <sessionsDir>/<cwd-slug>/<uuid>/session.v4.jsonl.zstd
  const cwdSlug = path.basename(path.dirname(path.dirname(filePath)));
  return decodeDshSlug(cwdSlug);
}

function extractLastEventTime(events: DshEvent[]): number | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i]?.time;
    if (typeof t === 'number' && Number.isFinite(t) && t > 0) return t;
  }
  return undefined;
}

function extractPendingTasks(events: DshEvent[]): string[] {
  let lastTodos: unknown[] | undefined;
  for (const event of events) {
    if (event.type === 'todo/write' && event.data && Array.isArray(event.data.todos)) {
      lastTodos = event.data.todos;
    }
  }
  if (!lastTodos) return [];
  const pending: string[] = [];
  for (const item of lastTodos) {
    if (!item || typeof item !== 'object') continue;
    const todo = item as { content?: unknown; title?: unknown; text?: unknown; status?: unknown; completed?: unknown };
    const status = typeof todo.status === 'string' ? todo.status.toLowerCase() : '';
    if (todo.completed === true || status === 'completed' || status === 'done' || status === 'cancelled') continue;
    const label =
      (typeof todo.content === 'string' && todo.content.trim()) ||
      (typeof todo.title === 'string' && todo.title.trim()) ||
      (typeof todo.text === 'string' && todo.text.trim()) ||
      '';
    if (label) pending.push(label);
  }
  return pending;
}

export interface ParseDshOptions extends SessionParseOptions {
  dshHome?: string;
  dshTuiDir?: string;
  decompressor?: ZstdDecompressor | null;
}

export async function parseDshSessions(options: ParseDshOptions = {}): Promise<UnifiedSession[]> {
  const dshHome = options.dshHome ?? resolveDshHome();
  const sessionsDir = path.join(dshHome, 'sessions');
  const files = findFiles(sessionsDir, {
    match: (entry) => SESSION_FILE_RE.test(entry.name),
    maxDepth: 3,
  });
  if (files.length === 0) return [];

  const tuiIndex = await readDshTuiIndex(options.dshTuiDir);
  const byId = new Map<string, { version: number; session: UnifiedSession }>();

  for (const filePath of files) {
    try {
      const events = await readDshEvents(filePath, options.decompressor);
      if (!events || events.length === 0) continue;

      const header = events[0];
      if (header?.type !== 'session' || !header.id) continue;
      if ((header.delegationDepth ?? 0) > 0 || header.parentSession) continue;
      if (!options.lightweight && events.length <= 1) continue;

      const stat = await fs.stat(filePath);
      const indexEntry = tuiIndex.get(header.id);
      const cwd = extractCwdFromEvents(events, filePath);
      const model = extractModelFromEvents(events, indexEntry?.model);
      const summary = extractTitleFromEvents(events, indexEntry);
      const lastEventTime = extractLastEventTime(events);

      const session: UnifiedSession = {
        id: header.id,
        source: 'dsh',
        cwd,
        repo: extractRepoFromCwd(cwd),
        branch: indexEntry?.branch,
        lines: events.length,
        bytes: stat.size,
        createdAt: typeof header.createdAt === 'number' ? new Date(header.createdAt) : stat.birthtime,
        updatedAt: lastEventTime ? new Date(lastEventTime) : stat.mtime,
        originalPath: filePath,
        summary,
        model,
      };

      const versionMatch = path.basename(filePath).match(SESSION_FILE_RE);
      const version = versionMatch?.[1] ? Number.parseInt(versionMatch[1], 10) : 0;
      const existing = byId.get(header.id);
      if (
        !existing ||
        version > existing.version ||
        (version === existing.version && session.updatedAt.getTime() > existing.session.updatedAt.getTime())
      ) {
        byId.set(header.id, { version, session });
      }
    } catch (err) {
      logger.debug('dsh: skipping unparseable session', filePath, err);
    }
  }

  return Array.from(byId.values())
    .map((entry) => entry.session)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractDshContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
  decompressor?: ZstdDecompressor | null,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const events = (await readDshEvents(session.originalPath, decompressor)) ?? [];
  const anthropic = toAnthropic(events);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropic, resolvedConfig);

  const sessionNotes: SessionNotes = {};
  const model = extractModelFromEvents(events, session.model);
  if (model) sessionNotes.model = model;

  // Last compaction/summary event
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (ev?.type === 'compaction/summary' && ev.data) {
      const summaryText = textOf(ev.data.summary).trim();
      if (summaryText) {
        sessionNotes.compactSummary = truncate(summaryText, 500);
        break;
      }
    }
  }

  // Reasoning highlights from assistant reasoning blocks (mapped to thinking)
  const reasoning = extractThinkingHighlights(
    anthropic.filter((m) => m.role === 'assistant'),
    undefined,
    resolvedConfig,
  );
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  // Token usage aggregation from assistant/message events
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  for (const ev of events) {
    if (ev.type !== 'assistant/message' || !ev.data?.usage || typeof ev.data.usage !== 'object') continue;
    const usage = ev.data.usage as {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    if (typeof usage.inputTokens === 'number') inputTokens += usage.inputTokens;
    if (typeof usage.outputTokens === 'number') outputTokens += usage.outputTokens;
    if (typeof usage.cacheReadTokens === 'number') cacheReadTokens += usage.cacheReadTokens;
    if (typeof usage.cacheWriteTokens === 'number') cacheWriteTokens += usage.cacheWriteTokens;
  }
  if (inputTokens > 0 || outputTokens > 0) {
    sessionNotes.tokenUsage = { input: inputTokens, output: outputTokens };
  }
  if (cacheReadTokens > 0 || cacheWriteTokens > 0) {
    sessionNotes.cacheTokens = { creation: cacheWriteTokens, read: cacheReadTokens };
  }

  const pendingTasks = extractPendingTasks(events);

  const messages: ConversationMessage[] = [];
  for (const ev of events) {
    if (isUserPromptEvent(ev)) {
      const text = textOf(ev.data?.content).trim();
      if (!text || isSystemContent(text)) continue;
      messages.push({
        role: 'user',
        content: text,
        timestamp: typeof ev.time === 'number' ? new Date(ev.time) : undefined,
        sourceId: typeof ev.data?.id === 'string' ? ev.data.id : undefined,
      });
    } else if (ev.type === 'assistant/message' && ev.data) {
      const msg = ev.data.message as { content?: unknown; id?: string } | undefined;
      const text = textOf(msg?.content).trim();
      if (!text || isSystemContent(text)) continue;
      messages.push({
        role: 'assistant',
        content: text,
        timestamp: typeof ev.time === 'number' ? new Date(ev.time) : undefined,
        sourceId: typeof msg?.id === 'string' ? msg.id : undefined,
      });
    }
  }

  const recentMessages = trimMessages(messages, resolvedConfig.recentMessages);
  const updatedSession = model ? { ...session, model } : session;
  const markdown = generateHandoffMarkdown(
    updatedSession,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    resolvedConfig,
  );

  return {
    session: updatedSession,
    recentMessages,
    filesModified,
    pendingTasks,
    toolSummaries,
    sessionNotes,
    markdown,
  };
}
