import * as fs from 'node:fs';
import * as path from 'node:path';
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
import { getFileStats, readJsonlFile, scanJsonlHead } from '../utils/jsonl.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir } from '../utils/parser-helpers.js';
import {
  type AnthropicMessage,
  extractAnthropicToolData,
  extractThinkingHighlights,
} from '../utils/tool-extraction.js';
import { truncate } from '../utils/tool-summarizer.js';

/**
 * Caveman Code (`caveman`, a fork of pi 0.65): pi's v3 session JSONL under
 * ~/.cave/agent/sessions/<cwd-slug>/<timestamp>_<uuid>.jsonl. Line 1 is the
 * `session` header; every later entry has id/parentId, so a file is a tree and
 * the conversation is the branch ending at the last entry.
 */
const CAVEMAN_SESSIONS_DIR = path.join(homeDir(), '.cave', 'agent', 'sessions');

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: unknown };
type PiMessage = { role: string; content: string | Block[]; toolCallId?: string; isError?: boolean };
type PiEntry = {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
  cwd?: string;
  modelId?: string;
  summary?: string;
  message?: PiMessage;
};

const textOf = (content: PiMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('\n');

/** The active branch: from the last entry back through parentId to the root, oldest first. */
export function activeBranch(entries: PiEntry[]): PiEntry[] {
  const byId = new Map(entries.filter((e) => e.id).map((e) => [e.id!, e]));
  const branch: PiEntry[] = [];
  const seen = new Set<string>();
  for (let e = entries.filter((x) => x.id).at(-1); e?.id && !seen.has(e.id); e = byId.get(e.parentId ?? '')) {
    seen.add(e.id);
    branch.push(e);
  }
  return branch.reverse();
}

/** pi's tool calls and results in Anthropic's shape, which the shared tool extractor reads. */
export function toAnthropic(entries: PiEntry[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const e of entries) {
    const m = e.message;
    if (e.type !== 'message' || !m) continue;
    if (m.role === 'toolResult') {
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: textOf(m.content), is_error: m.isError }],
      });
    } else if (m.role === 'user' || m.role === 'assistant') {
      const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      out.push({
        role: m.role,
        content: blocks.map((b) =>
          b.type === 'toolCall' ? { type: 'tool_use', id: b.id, name: b.name, input: b.arguments ?? {} } : b,
        ),
      });
    }
  }
  return out;
}

export async function parseCavemanSessions(options: SessionParseOptions = {}): Promise<UnifiedSession[]> {
  const files = findFiles(CAVEMAN_SESSIONS_DIR, { match: (entry) => entry.name.endsWith('.jsonl'), maxDepth: 2 });
  const sessions: UnifiedSession[] = [];
  for (const filePath of files) {
    try {
      let header: PiEntry | undefined;
      let firstUser = '';
      let model: string | undefined;
      await scanJsonlHead(filePath, 200, (parsed) => {
        const e = parsed as PiEntry;
        if (e.type === 'session' && !header) header = e;
        if (e.type === 'model_change' && !model) model = e.modelId;
        if (!firstUser && e.type === 'message' && e.message?.role === 'user')
          firstUser = textOf(e.message.content).trim();
        return header && firstUser && model ? 'stop' : 'continue';
      });
      if (header?.type !== 'session' || !header.id) continue;
      const stat = fs.statSync(filePath);
      const stats = options.lightweight ? { lines: 0, bytes: stat.size } : await getFileStats(filePath);
      const cwd = header.cwd || '';
      sessions.push({
        id: header.id,
        source: 'caveman',
        cwd,
        repo: extractRepoFromCwd(cwd),
        lines: stats.lines,
        bytes: stat.size,
        createdAt: header.timestamp ? new Date(header.timestamp) : stat.birthtime,
        updatedAt: stat.mtime,
        originalPath: filePath,
        summary: cleanSummary(firstUser) || undefined,
        model,
      });
    } catch (err) {
      logger.debug('caveman: skipping unparseable session', filePath, err);
    }
  }
  return sessions
    .filter((s) => options.lightweight || s.lines > 1)
    .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

export async function extractCavemanContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');
  const branch = activeBranch(await readJsonlFile<PiEntry>(session.originalPath));
  const anthropic = toAnthropic(branch);
  const { summaries: toolSummaries, filesModified } = extractAnthropicToolData(anthropic, resolvedConfig);

  const sessionNotes: SessionNotes = {};
  const model = branch.filter((e) => e.type === 'model_change').at(-1)?.modelId ?? session.model;
  if (model) sessionNotes.model = model;
  const compaction = branch.filter((e) => e.type === 'compaction' && e.summary).at(-1);
  if (compaction?.summary) sessionNotes.compactSummary = truncate(compaction.summary, 500);
  const reasoning = extractThinkingHighlights(anthropic.filter((m) => m.role === 'assistant'));
  if (reasoning.length > 0) sessionNotes.reasoning = reasoning;

  const messages: ConversationMessage[] = [];
  for (const e of branch) {
    const m = e.message;
    if (e.type !== 'message' || !m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const text = textOf(m.content).trim();
    if (!text || isSystemContent(text)) continue;
    messages.push({
      role: m.role,
      content: text,
      timestamp: e.timestamp ? new Date(e.timestamp) : undefined,
      sourceId: e.id,
      sourceParentId: e.parentId ?? undefined,
    });
  }
  const recentMessages = messages.slice(-resolvedConfig.recentMessages);
  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    filesModified,
    [],
    toolSummaries,
    sessionNotes,
    resolvedConfig,
  );
  return {
    session: model ? { ...session, model } : session,
    recentMessages,
    filesModified,
    pendingTasks: [],
    toolSummaries,
    sessionNotes,
    markdown,
  };
}
