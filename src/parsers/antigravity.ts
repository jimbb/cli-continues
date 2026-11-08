import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as https from 'node:https';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as readline from 'node:readline';
import type { VerbosityConfig } from '../config/index.js';
import { getPreset } from '../config/index.js';
import { logger } from '../logger.js';
import type {
  ConversationMessage,
  SessionContext,
  SessionNotes,
  SessionParseOptions,
  SessionSource,
  ToolCall,
  UnifiedSession,
} from '../types/index.js';
import {
  ASK_TOOLS,
  EDIT_TOOLS,
  FETCH_TOOLS,
  GLOB_TOOLS,
  GREP_TOOLS,
  READ_TOOLS,
  SEARCH_TOOLS,
  SHELL_TOOLS,
  SKIP_TOOLS,
  TASK_TOOLS,
  WRITE_TOOLS,
} from '../types/tool-names.js';
import { countDiffStats } from '../utils/diff.js';
import { generateHandoffMarkdown } from '../utils/markdown.js';
import { cleanSummary, extractRepoFromCwd, homeDir, trimMessages } from '../utils/parser-helpers.js';
import { matchesCwd } from '../utils/slug.js';
import {
  extractExitCode,
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

const SOURCE_NAME: SessionSource = 'antigravity';
const SUMMARY_STATE_KEYS = ['antigravityUnifiedStateSync.trajectorySummaries', 'unifiedStateSync.trajectorySummaries'];
const BRAIN_ARTIFACT_BASE_FILES = ['task.md', 'implementation_plan.md', 'walkthrough.md'];
const UUIDISH_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const RPC_TIMEOUT_MS = 1500;
const LAUNCH_POLL_INTERVAL_MS_DEFAULT = 500;
const LAUNCH_TIMEOUT_MS_DEFAULT = 25_000;

function envOverrideMs(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getLaunchPollIntervalMs(): number {
  return envOverrideMs('CONTINUES_LAUNCH_POLL_INTERVAL_MS', LAUNCH_POLL_INTERVAL_MS_DEFAULT);
}

function getLaunchTimeoutMs(): number {
  return envOverrideMs('CONTINUES_LAUNCH_TIMEOUT_MS', LAUNCH_TIMEOUT_MS_DEFAULT);
}

interface SqlitePreparedStatement {
  get(...params: unknown[]): unknown | undefined;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabase {
  prepare(sql: string): SqlitePreparedStatement;
  close(): void;
}

interface StateSummary {
  id: string;
  title?: string;
  cwd?: string;
  createdAt?: Date;
  updatedAt?: Date;
  stepCount?: number;
}

interface LiveSummary extends StateSummary {
  model?: string;
}

interface AntigravityRecord {
  id: string;
  conversationPath?: string;
  brainDir?: string;
  transcriptPath?: string;
  compactTranscriptPath?: string;
  legacyPath?: string;
  state?: StateSummary;
  cli?: StateSummary;
  live?: LiveSummary;
  isSubagent?: boolean;
}

interface TranscriptMetadata {
  stepCount: number;
  firstUserPrompt?: string;
  model?: string;
  createdAt?: Date;
  updatedAt?: Date;
  cwd?: string;
}

interface AntigravityEntry {
  type: string;
  timestamp: string;
  content: string;
}

interface RpcConnection {
  port: number;
  csrfToken: string;
}

interface ProcessRecord {
  pid?: string;
  commandLine: string;
}

interface RpcStepExtraction {
  messages: ConversationMessage[];
  toolSummaries: ReturnType<SummaryCollector['getSummaries']>;
  filesModified: string[];
  pendingTasks: string[];
  sessionNotes?: SessionNotes;
}

interface ProtoVarint {
  value: number;
  offset: number;
}

interface ProtoLengthDelimited {
  bytes: Uint8Array;
  offset: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function expandHome(value: string): string {
  if (value === '~') return homeDir();
  if (value.startsWith(`~${path.sep}`)) return path.join(homeDir(), value.slice(2));
  return value;
}

function getAntigravityRoots(): string[] {
  const explicitHome = process.env.ANTIGRAVITY_HOME?.trim();
  const explicitCliHome = process.env.ANTIGRAVITY_CLI_HOME?.trim();
  if (explicitHome || explicitCliHome) {
    return Array.from(new Set([explicitHome, explicitCliHome].filter(isNonEmptyString).map((dir) => expandHome(dir))));
  }

  const geminiHome = process.env.GEMINI_CLI_HOME?.trim();
  if (geminiHome) {
    const resolved = expandHome(geminiHome);
    const baseName = path.basename(resolved);
    if (baseName === 'antigravity' || baseName === 'antigravity-cli') {
      return [resolved];
    }
    return [path.join(resolved, '.gemini', 'antigravity-cli'), path.join(resolved, '.gemini', 'antigravity')];
  }

  const appDataDir = process.env.ANTIGRAVITY_APP_DATA_DIR?.trim();
  const defaults = [
    ...(appDataDir ? [expandHome(appDataDir)] : []),
    path.join(homeDir(), '.gemini', 'antigravity-cli'),
    path.join(homeDir(), '.gemini', 'antigravity'),
  ];
  return Array.from(new Set(defaults));
}

function getAntigravityRoot(): string {
  return getAntigravityRoots()[0] ?? path.join(homeDir(), '.gemini', 'antigravity');
}

function getStateDbPaths(): string[] {
  const explicit = process.env.ANTIGRAVITY_STATE_DB?.trim();
  if (explicit) return [expandHome(explicit)];

  if (process.platform === 'darwin') {
    return [
      path.join(homeDir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    ];
  }

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir(), 'AppData', 'Roaming');
    return [path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb')];
  }

  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir(), '.config');
  return [path.join(xdgConfig, 'Antigravity', 'User', 'globalStorage', 'state.vscdb')];
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fsp.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dirPath: string): Promise<fs.Dirent[]> {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logger.debug('antigravity: failed to read directory', dirPath, err);
    return [];
  }
}

async function statSafe(filePath: string): Promise<fs.Stats | undefined> {
  try {
    return await fsp.stat(filePath);
  } catch (err) {
    logger.debug('antigravity: failed to stat path', filePath, err);
    return undefined;
  }
}

function validDate(value: Date | undefined): Date | undefined {
  return value && !Number.isNaN(value.getTime()) ? value : undefined;
}

function parseTimestamp(value: string | undefined, fallback?: Date): Date | undefined {
  if (!value) return fallback;
  const trimmed = value.trim();
  // Go's zero time.Time serializes as "0001-01-01 00:00:00+00:00", which V8's
  // Date parser misinterprets as year 2001. Reject year 0000/0001 timestamps.
  if (!trimmed || /^000[01]-01-01/u.test(trimmed)) return fallback;
  const parsed = validDate(new Date(trimmed));
  if (!parsed || parsed.getTime() <= 0) return fallback;
  return parsed;
}

function dateFromEpoch(value: number | undefined): Date | undefined {
  if (!value || !Number.isFinite(value)) return undefined;
  const millis = value < 10_000_000_000 ? value * 1000 : value;
  return validDate(new Date(millis));
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (isNonEmptyString(value)) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return undefined;
}

function firstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (isNonEmptyString(value)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function recordAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = record[key];
  return isRecord(value) ? value : {};
}

function stringifyPreview(value: unknown, maxLength = 160): string | undefined {
  if (isNonEmptyString(value)) return truncate(value.replace(/\s+/gu, ' ').trim(), maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return undefined;

  try {
    return truncate(JSON.stringify(value).replace(/\s+/gu, ' ').trim(), maxLength);
  } catch (err) {
    logger.debug('antigravity: failed to stringify preview value', err);
    return undefined;
  }
}

function decodeFileUri(uri: string): string | undefined {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'file:') return undefined;
    const pathname = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/u.test(pathname)) return pathname.slice(1);
    return pathname;
  } catch {
    return undefined;
  }
}

function normalizeCwd(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('file://')) return decodeFileUri(value);
  return value;
}

function parseWorkspaceUris(raw: unknown): string | undefined {
  if (!isNonEmptyString(raw)) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (isNonEmptyString(item)) {
            const cwd = normalizeCwd(item.trim());
            if (cwd) return cwd;
          }
        }
      }
    } catch (err) {
      logger.debug('antigravity: failed to parse workspace_uris JSON', err);
    }
    return undefined;
  }
  return normalizeCwd(trimmed);
}

function trimAtControlCharacter(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) < 32) return value.slice(0, index);
  }
  return value;
}

function addRecord(records: Map<string, AntigravityRecord>, id: string, patch: Partial<AntigravityRecord>): void {
  if (!id) return;
  const existing = records.get(id) ?? { id };
  records.set(id, { ...existing, ...patch, id });
}

function mergeCliSummary(existing: StateSummary | undefined, patch: StateSummary): StateSummary {
  if (!existing) return patch;
  const createdAt =
    existing.createdAt && patch.createdAt
      ? new Date(Math.min(existing.createdAt.getTime(), patch.createdAt.getTime()))
      : (existing.createdAt ?? patch.createdAt);
  const updatedAt =
    existing.updatedAt && patch.updatedAt
      ? new Date(Math.max(existing.updatedAt.getTime(), patch.updatedAt.getTime()))
      : (existing.updatedAt ?? patch.updatedAt);
  return {
    id: existing.id,
    ...((existing.title ?? patch.title) ? { title: existing.title ?? patch.title } : {}),
    ...((existing.cwd ?? patch.cwd) ? { cwd: existing.cwd ?? patch.cwd } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...((existing.stepCount ?? patch.stepCount) ? { stepCount: existing.stepCount ?? patch.stepCount } : {}),
  };
}

async function discoverConversationRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  for (const root of getAntigravityRoots()) {
    const conversationsDir = path.join(root, 'conversations');
    for (const entry of await readDirSafe(conversationsDir)) {
      if (!entry.isFile() || !entry.name.endsWith('.pb')) continue;
      const id = path.basename(entry.name, '.pb');
      addRecord(records, id, { conversationPath: path.join(conversationsDir, entry.name) });
    }
  }
}

async function findBrainArtifactPath(brainDir: string, baseName: string): Promise<string | undefined> {
  const entries = await readDirSafe(brainDir);
  const exact = entries.find((entry) => entry.isFile() && entry.name === baseName);
  if (exact) return path.join(brainDir, exact.name);

  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${baseName}.resolved`))
    .map((entry) => path.join(brainDir, entry.name));
  if (candidates.length === 0) return undefined;

  const withStats = await Promise.all(
    candidates.map(async (candidate) => ({ candidate, stats: await statSafe(candidate) })),
  );
  return withStats
    .filter((item): item is { candidate: string; stats: fs.Stats } => item.stats !== undefined)
    .sort((left, right) => right.stats.mtimeMs - left.stats.mtimeMs)[0]?.candidate;
}

async function hasBrainArtifacts(dirPath: string): Promise<boolean> {
  for (const fileName of BRAIN_ARTIFACT_BASE_FILES) {
    if (await findBrainArtifactPath(dirPath, fileName)) return true;
  }
  return false;
}

async function findTranscriptPaths(
  brainDir: string,
): Promise<{ transcriptPath: string; compactTranscriptPath: string } | undefined> {
  const logsDir = path.join(brainDir, '.system_generated', 'logs');
  const fullPath = path.join(logsDir, 'transcript_full.jsonl');
  const compactPath = path.join(logsDir, 'transcript.jsonl');
  const hasFull = await exists(fullPath);
  const hasCompact = await exists(compactPath);
  if (!hasFull && !hasCompact) return undefined;
  return {
    transcriptPath: hasFull ? fullPath : compactPath,
    compactTranscriptPath: hasCompact ? compactPath : fullPath,
  };
}

async function discoverBrainRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  for (const root of getAntigravityRoots()) {
    const brainDir = path.join(root, 'brain');
    for (const entry of await readDirSafe(brainDir)) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(brainDir, entry.name);
      const transcripts = await findTranscriptPaths(dirPath);
      if (transcripts) {
        addRecord(records, entry.name, {
          brainDir: dirPath,
          transcriptPath: transcripts.transcriptPath,
          compactTranscriptPath: transcripts.compactTranscriptPath,
        });
        continue;
      }
      if (!UUIDISH_RE.test(entry.name) && !(await hasBrainArtifacts(dirPath))) continue;
      addRecord(records, entry.name, { brainDir: dirPath });
    }
  }
}

async function discoverCliSummaryRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  for (const root of getAntigravityRoots()) {
    const dbPath = path.join(root, 'conversation_summaries.db');
    if (fs.existsSync(dbPath)) {
      const handle = openDb(dbPath);
      if (handle) {
        try {
          const rows = handle.db
            .prepare(
              `SELECT
                 conversation_id,
                 title,
                 preview,
                 step_count,
                 last_modified_time,
                 last_user_input_time,
                 workspace_uris,
                 parent_conversation_id,
                 nesting_depth
               FROM conversation_summaries`,
            )
            .all();
          for (const rawRow of rows) {
            if (!isRecord(rawRow)) continue;
            const id = firstString(rawRow, ['conversation_id']);
            if (!id) continue;
            const parentId = firstString(rawRow, ['parent_conversation_id']);
            const nestingDepth = firstNumber(rawRow, ['nesting_depth']);
            if (isNonEmptyString(parentId) || (nestingDepth !== undefined && nestingDepth > 0)) {
              addRecord(records, id, { isSubagent: true });
              continue;
            }
            const title = firstString(rawRow, ['title']) ?? firstString(rawRow, ['preview']);
            const cwd = parseWorkspaceUris(rawRow.workspace_uris);
            const rawStepCount = firstNumber(rawRow, ['step_count']);
            const stepCount = rawStepCount && rawStepCount > 0 ? rawStepCount : undefined;
            const updatedAt =
              parseTimestamp(firstString(rawRow, ['last_modified_time'])) ??
              parseTimestamp(firstString(rawRow, ['last_user_input_time']));
            const createdAt = parseTimestamp(firstString(rawRow, ['last_user_input_time'])) ?? updatedAt;
            const existing = records.get(id);
            const cli = mergeCliSummary(existing?.cli, {
              id,
              ...(title ? { title } : {}),
              ...(cwd ? { cwd } : {}),
              ...(createdAt ? { createdAt } : {}),
              ...(updatedAt ? { updatedAt } : {}),
              ...(stepCount ? { stepCount } : {}),
            });
            addRecord(records, id, { cli });
          }
        } catch (err) {
          logger.debug('antigravity: failed to read conversation_summaries.db', dbPath, err);
        } finally {
          handle.close();
        }
      }
    }

    const historyPath = path.join(root, 'history.jsonl');
    if (await exists(historyPath)) {
      try {
        const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const obj: unknown = JSON.parse(trimmed);
            if (!isRecord(obj)) continue;
            const id = firstString(obj, ['conversationId', 'conversation_id', 'id']);
            if (!id) continue;
            const cwd = normalizeCwd(firstString(obj, ['workspace', 'cwd']));
            const ts = dateFromEpoch(firstNumber(obj, ['timestamp']));
            const display = firstString(obj, ['display', 'prompt', 'text']);
            const entryType = firstString(obj, ['type']);
            const isSlash = entryType === 'slash_command' || (display ? display.startsWith('/') : false);
            const existing = records.get(id);
            const cli = mergeCliSummary(existing?.cli, {
              id,
              ...(!isSlash && display ? { title: display } : {}),
              ...(cwd ? { cwd } : {}),
              ...(ts ? { createdAt: ts, updatedAt: ts } : {}),
            });
            addRecord(records, id, { cli });
          } catch (err) {
            logger.debug('antigravity: skipping malformed history.jsonl line', err);
          }
        }
      } catch (err) {
        logger.debug('antigravity: failed to read history.jsonl', historyPath, err);
      }
    }
  }
}

function stripBinaryPrefix(line: string): string | null {
  const idx = line.indexOf('{');
  if (idx === -1) return null;
  return line.slice(idx);
}

function parseLegacyLine(line: string): AntigravityEntry | null {
  if (!line) return null;
  const json = stripBinaryPrefix(line);
  if (!json) return null;

  try {
    const obj: unknown = JSON.parse(json);
    if (isRecord(obj) && isNonEmptyString(obj.type) && typeof obj.content === 'string') {
      return {
        type: obj.type,
        timestamp: typeof obj.timestamp === 'string' ? obj.timestamp : '',
        content: obj.content,
      };
    }
  } catch {
    return null;
  }

  return null;
}

async function parseLegacySessionFile(filePath: string): Promise<AntigravityEntry[]> {
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    const entries: AntigravityEntry[] = [];
    for await (const line of rl) {
      const entry = parseLegacyLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  } catch (err) {
    logger.debug('antigravity: failed to read legacy session file', filePath, err);
    return [];
  }
}

async function findLegacySessionFiles(codeTrackerDir: string): Promise<string[]> {
  const pendingDirs = [codeTrackerDir];
  const files: string[] = [];

  while (pendingDirs.length > 0) {
    const dirPath = pendingDirs.pop()!;
    for (const entry of await readDirSafe(dirPath)) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(entryPath);
      } else if (entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.jsonl'))) {
        files.push(entryPath);
      }
    }
  }

  return files;
}

async function discoverLegacyRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  for (const root of getAntigravityRoots()) {
    const codeTrackerDir = path.join(root, 'code_tracker');
    for (const filePath of await findLegacySessionFiles(codeTrackerDir)) {
      const entries = await parseLegacySessionFile(filePath);
      if (!entries.some((entry) => entry.type === 'user' || entry.type === 'assistant')) continue;
      const ext = path.extname(filePath);
      // Use the code_tracker-relative path (separators → ':') so two legacy
      // sessions whose basenames collide across subdirectories don't merge in
      // addRecord. Falls back to basename for any file outside code_tracker/.
      const relative = path.relative(codeTrackerDir, filePath);
      const idBase =
        relative && !relative.startsWith('..')
          ? relative.slice(0, -ext.length).replace(/[\\/]/gu, ':')
          : path.basename(filePath, ext);
      addRecord(records, `legacy:${idBase}`, { legacyPath: filePath });
    }
  }
}

function openDb(dbPath: string): { db: SqliteDatabase; close: () => void } | null {
  try {
    const require = createRequire(import.meta.url);
    const sqliteModule = require('node:sqlite') as {
      DatabaseSync: new (database: string, options?: { open?: boolean; readOnly?: boolean }) => SqliteDatabase;
    };
    const db = new sqliteModule.DatabaseSync(dbPath, { open: true, readOnly: true });
    return { db, close: () => db.close() };
  } catch (err) {
    logger.debug('antigravity: failed to open state database', dbPath, err);
    return null;
  }
}

function readStateValue(dbPath: string, key: string): string | undefined {
  const handle = openDb(dbPath);
  if (!handle) return undefined;

  try {
    const row = handle.db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    if (!isRecord(row)) return undefined;
    const value = row.value;
    if (typeof value === 'string') return value;
    if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
    return value == null ? undefined : String(value);
  } catch (err) {
    logger.debug('antigravity: failed to read state key', key, err);
    return undefined;
  } finally {
    handle.close();
  }
}

function base64ToBytes(value: string | undefined): Uint8Array | undefined {
  if (!value) return undefined;
  try {
    return Uint8Array.from(Buffer.from(value.trim(), 'base64'));
  } catch {
    return undefined;
  }
}

function bytesToUtf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function readVarint(buf: Uint8Array, offset: number): ProtoVarint | null {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buf.length) {
    const byte = buf[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, offset: cursor };
    shift += 7;
    if (shift > 53) return null;
  }

  return null;
}

function readLengthDelimited(buf: Uint8Array, offset: number): ProtoLengthDelimited | null {
  const lenResult = readVarint(buf, offset);
  if (!lenResult) return null;
  const start = lenResult.offset;
  const end = start + lenResult.value;
  if (end > buf.length) return null;
  return { bytes: buf.subarray(start, end), offset: end };
}

function skipField(buf: Uint8Array, offset: number, wireType: number): { offset: number } | null {
  if (wireType === 0) {
    const value = readVarint(buf, offset);
    return value ? { offset: value.offset } : null;
  }
  if (wireType === 1) {
    const end = offset + 8;
    return end <= buf.length ? { offset: end } : null;
  }
  if (wireType === 2) {
    const value = readLengthDelimited(buf, offset);
    return value ? { offset: value.offset } : null;
  }
  if (wireType === 5) {
    const end = offset + 4;
    return end <= buf.length ? { offset: end } : null;
  }
  return null;
}

function parseTimestampMessage(bytes: Uint8Array): number | undefined {
  let seconds: number | undefined;
  let nanos = 0;
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return undefined;
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (!value) return undefined;
      offset = value.offset;
      if (fieldNumber === 1) seconds = value.value;
      if (fieldNumber === 2) nanos = value.value;
      continue;
    }

    const skipped = skipField(bytes, offset, wireType);
    if (!skipped) return undefined;
    offset = skipped.offset;
  }

  if (!seconds || seconds < 946_684_800 || seconds > 4_102_444_800) return undefined;
  return Math.round(seconds * 1000 + Math.min(nanos, 999_999_999) / 1_000_000);
}

function findTimestampInProto(bytes: Uint8Array, maxDepth: number, depth = 0): number | undefined {
  const direct = parseTimestampMessage(bytes);
  if (direct) return direct;
  if (depth >= maxDepth) return undefined;

  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return undefined;
    offset = tag.offset;
    const wireType = tag.value & 0x7;

    if (wireType !== 2) {
      const skipped = skipField(bytes, offset, wireType);
      if (!skipped) return undefined;
      offset = skipped.offset;
      continue;
    }

    const nested = readLengthDelimited(bytes, offset);
    if (!nested) return undefined;
    offset = nested.offset;
    const timestamp = findTimestampInProto(nested.bytes, maxDepth, depth + 1);
    if (timestamp) return timestamp;
  }

  return undefined;
}

function* iterUtf8StringsInProto(bytes: Uint8Array, maxDepth: number, depth = 0): Generator<string> {
  if (depth > maxDepth) return;

  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) return;
    offset = tag.offset;
    const wireType = tag.value & 0x7;

    if (wireType !== 2) {
      const skipped = skipField(bytes, offset, wireType);
      if (!skipped) return;
      offset = skipped.offset;
      continue;
    }

    const value = readLengthDelimited(bytes, offset);
    if (!value) return;
    offset = value.offset;

    const text = bytesToUtf8(value.bytes);
    if (text) yield text;
    yield* iterUtf8StringsInProto(value.bytes, maxDepth, depth + 1);
  }
}

function extractFolderFromSummaryProto(bytes: Uint8Array): string | undefined {
  for (const text of iterUtf8StringsInProto(bytes, 6)) {
    const match = text.match(/#?file:\/\/[^\s"]+/u);
    if (!match) continue;
    const rawUri = match[0].startsWith('#') ? match[0].slice(1) : match[0];
    const uri = trimAtControlCharacter(rawUri);
    const folder = decodeFileUri(uri);
    if (folder) return folder;
  }
  return undefined;
}

function extractStateSummaryFromProto(id: string, bytes: Uint8Array): StateSummary {
  let title: string | undefined;
  let primaryCount = 0;
  let secondaryCount = 0;
  const timestamps: number[] = [];
  let offset = 0;

  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (!tag) break;
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (!value) break;
      offset = value.offset;
      if (fieldNumber === 2) primaryCount = value.value;
      if (fieldNumber === 16) secondaryCount = value.value;
      continue;
    }

    if (wireType === 2) {
      const value = readLengthDelimited(bytes, offset);
      if (!value) break;
      offset = value.offset;

      if (fieldNumber === 1 && !title) {
        const text = bytesToUtf8(value.bytes);
        if (text?.trim()) title = text.trim();
        continue;
      }

      if (fieldNumber === 3 || fieldNumber === 7 || fieldNumber === 10 || fieldNumber === 15) {
        const timestamp =
          fieldNumber === 15
            ? findTimestampInProto(value.bytes, 2)
            : (parseTimestampMessage(value.bytes) ?? findTimestampInProto(value.bytes, 1));
        if (timestamp) timestamps.push(timestamp);
      }
      continue;
    }

    const skipped = skipField(bytes, offset, wireType);
    if (!skipped) break;
    offset = skipped.offset;
  }

  const uniqueTimestamps = Array.from(new Set(timestamps)).sort((a, b) => a - b);
  const cwd = extractFolderFromSummaryProto(bytes);
  return {
    id,
    ...(title ? { title } : {}),
    ...(cwd ? { cwd } : {}),
    ...(uniqueTimestamps[0] ? { createdAt: new Date(uniqueTimestamps[0]) } : {}),
    ...(uniqueTimestamps.at(-1) ? { updatedAt: new Date(uniqueTimestamps.at(-1)!) } : {}),
    ...(Math.max(primaryCount, secondaryCount) > 0 ? { stepCount: Math.max(primaryCount, secondaryCount) } : {}),
  };
}

function parseStateSummaryMap(value: string): Map<string, StateSummary> {
  const outerBytes = base64ToBytes(value);
  const summaries = new Map<string, StateSummary>();
  if (!outerBytes) return summaries;

  let offset = 0;
  while (offset < outerBytes.length) {
    const tag = readVarint(outerBytes, offset);
    if (!tag) break;
    offset = tag.offset;
    const fieldNumber = tag.value >>> 3;
    const wireType = tag.value & 0x7;

    if (fieldNumber !== 1 || wireType !== 2) {
      const skipped = skipField(outerBytes, offset, wireType);
      if (!skipped) break;
      offset = skipped.offset;
      continue;
    }

    const entry = readLengthDelimited(outerBytes, offset);
    if (!entry) break;
    offset = entry.offset;

    let sessionId: string | undefined;
    let summaryBase64: string | undefined;
    let entryOffset = 0;
    while (entryOffset < entry.bytes.length) {
      const entryTag = readVarint(entry.bytes, entryOffset);
      if (!entryTag) break;
      entryOffset = entryTag.offset;
      const entryField = entryTag.value >>> 3;
      const entryWire = entryTag.value & 0x7;

      if (entryField === 1 && entryWire === 2) {
        const key = readLengthDelimited(entry.bytes, entryOffset);
        if (!key) break;
        entryOffset = key.offset;
        sessionId = bytesToUtf8(key.bytes);
        continue;
      }

      if (entryField === 2 && entryWire === 2) {
        const stateValue = readLengthDelimited(entry.bytes, entryOffset);
        if (!stateValue) break;
        entryOffset = stateValue.offset;

        let valueOffset = 0;
        while (valueOffset < stateValue.bytes.length) {
          const valueTag = readVarint(stateValue.bytes, valueOffset);
          if (!valueTag) break;
          valueOffset = valueTag.offset;
          const valueField = valueTag.value >>> 3;
          const valueWire = valueTag.value & 0x7;

          if (valueField === 1 && valueWire === 2) {
            const summaryValue = readLengthDelimited(stateValue.bytes, valueOffset);
            if (!summaryValue) break;
            valueOffset = summaryValue.offset;
            summaryBase64 = bytesToUtf8(summaryValue.bytes);
            break;
          }

          const skipped = skipField(stateValue.bytes, valueOffset, valueWire);
          if (!skipped) break;
          valueOffset = skipped.offset;
        }
        continue;
      }

      const skipped = skipField(entry.bytes, entryOffset, entryWire);
      if (!skipped) break;
      entryOffset = skipped.offset;
    }

    if (!sessionId || !summaryBase64) continue;
    const summaryBytes = base64ToBytes(summaryBase64);
    if (!summaryBytes) continue;
    summaries.set(sessionId, extractStateSummaryFromProto(sessionId, summaryBytes));
  }

  return summaries;
}

function loadStateSummaries(): Map<string, StateSummary> {
  const combined = new Map<string, StateSummary>();

  for (const dbPath of getStateDbPaths()) {
    if (!fs.existsSync(dbPath)) continue;
    for (const key of SUMMARY_STATE_KEYS) {
      const value = readStateValue(dbPath, key);
      if (!value) continue;
      for (const [id, summary] of parseStateSummaryMap(value)) {
        combined.set(id, summary);
      }
      if (combined.size > 0) break;
    }
  }

  return combined;
}

async function discoverStateRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  for (const [id, state] of loadStateSummaries()) {
    addRecord(records, id, { state });
  }
}

function parseLiveSummary(id: string, raw: unknown): LiveSummary | null {
  if (!isRecord(raw)) return null;
  const workspace = Array.isArray(raw.workspaces) && isRecord(raw.workspaces[0]) ? raw.workspaces[0] : {};
  const cwd =
    normalizeCwd(firstString(workspace, ['workspaceFolderAbsoluteUri', 'workspaceFolderUri', 'uri', 'path'])) ??
    normalizeCwd(firstString(raw, ['cwd', 'folder', 'workspaceFolderAbsoluteUri', 'workspaceFolderUri']));
  const createdAt = parseTimestamp(firstString(raw, ['createdTime', 'createdAt', 'creationTime']));
  const updatedAt = parseTimestamp(firstString(raw, ['lastModifiedTime', 'updatedAt', 'lastUpdatedAt']));
  const rawModel = firstString(raw, ['lastGeneratorModelUid', 'model', 'modelUid']);

  return {
    id,
    ...(firstString(raw, ['summary', 'title', 'name'])
      ? { title: firstString(raw, ['summary', 'title', 'name']) }
      : {}),
    ...(cwd ? { cwd } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(firstNumber(raw, ['stepCount', 'bubbleCount', 'messageCount'])
      ? {
          stepCount: firstNumber(raw, ['stepCount', 'bubbleCount', 'messageCount']),
        }
      : {}),
    ...(rawModel ? { model: normalizeModelName(rawModel) } : {}),
  };
}

function parseLiveSummaryResponse(response: unknown): Map<string, LiveSummary> {
  const summaries = new Map<string, LiveSummary>();
  if (!isRecord(response)) return summaries;
  const rawSummaries = response.trajectorySummaries ?? response.cascadeTrajectories ?? response.trajectories;

  if (Array.isArray(rawSummaries)) {
    for (const item of rawSummaries) {
      if (!isRecord(item)) continue;
      const id = firstString(item, ['cascadeId', 'composerId', 'id', 'trajectoryId']);
      if (!id) continue;
      const parsed = parseLiveSummary(id, item);
      if (parsed) summaries.set(id, parsed);
    }
    return summaries;
  }

  if (isRecord(rawSummaries)) {
    for (const [id, summary] of Object.entries(rawSummaries)) {
      const parsed = parseLiveSummary(id, summary);
      if (parsed) summaries.set(id, parsed);
    }
  }

  return summaries;
}

function parsePortFlag(commandLine: string, flag: string): number | undefined {
  const value = commandLine.match(new RegExp(`--${flag}\\s+(\\d+)`, 'u'))?.[1];
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function parseFallbackPort(commandLine: string): number | undefined {
  const explicit =
    parsePortFlag(commandLine, 'server_port') ??
    parsePortFlag(commandLine, 'api_server_port') ??
    parsePortFlag(commandLine, 'extension_server_port');
  return explicit;
}

function isAntigravityLanguageServer(commandLine: string): boolean {
  return commandLine.includes('language_server_') && commandLine.includes('--app_data_dir antigravity');
}

function parseRpcConnectionFromCommand(commandLine: string, listeningPorts: number[]): RpcConnection | null {
  if (!isAntigravityLanguageServer(commandLine)) return null;
  const csrfToken = commandLine.match(/--csrf_token\s+(\S+)/u)?.[1];
  const preferredPort = parsePortFlag(commandLine, 'server_port');
  const port =
    preferredPort && listeningPorts.includes(preferredPort)
      ? preferredPort
      : (listeningPorts[0] ?? parseFallbackPort(commandLine));
  if (!csrfToken || !port) return null;
  return { port, csrfToken };
}

function runExecFile(
  file: string,
  args: string[],
  options: childProcess.ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string }> {
  const execFile = (childProcess as { execFile?: typeof childProcess.execFile }).execFile;
  if (typeof execFile !== 'function') {
    return Promise.reject(new Error('child_process.execFile is unavailable'));
  }

  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout });
    });
  });
}

async function getProcessRecords(): Promise<ProcessRecord[]> {
  try {
    const command =
      process.platform === 'win32'
        ? {
            file: 'powershell',
            args: [
              '-NoProfile',
              '-Command',
              'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine',
            ],
          }
        : { file: 'ps', args: ['-axo', 'pid=,command='] };
    const { stdout } = await runExecFile(command.file, command.args, {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (process.platform === 'win32') {
      return stdout
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((commandLine) => ({ commandLine }));
    }

    return stdout.split('\n').flatMap((line): ProcessRecord[] => {
      const match = line.match(/^\s*(\d+)\s+(.+)$/u);
      return match ? [{ pid: match[1], commandLine: match[2].trim() }] : [];
    });
  } catch (err) {
    logger.debug('antigravity: failed to inspect running language server', err);
    return [];
  }
}

async function getListeningPorts(pid: string | undefined): Promise<number[]> {
  if (!pid || process.platform === 'win32') return [];

  try {
    const { stdout } = await runExecFile('lsof', ['-i', 'TCP', '-P', '-n', '-a', '-p', pid], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout
      .split('\n')
      .flatMap((line): number[] => {
        const match = line.match(/TCP\s+(?:127\.0\.0\.1|localhost|\*):(\d+)\s+\(LISTEN\)/u);
        if (!match) return [];
        const port = Number(match[1]);
        return Number.isInteger(port) && port > 0 ? [port] : [];
      })
      .sort((left, right) => left - right);
  } catch (err) {
    logger.debug('antigravity: failed to inspect language server ports', err);
    return [];
  }
}

async function findRpcConnection(): Promise<RpcConnection | null> {
  if (process.env.ANTIGRAVITY_DISABLE_RPC === '1') return null;

  // Filter by the cheap command-line predicate first so we only spawn
  // `lsof` for genuine Antigravity language-server candidates. Without this,
  // normal indexing on machines where Antigravity is not running would
  // shell out once per process listed by `ps` (hundreds of invocations).
  const candidates = (await getProcessRecords()).filter((record) => isAntigravityLanguageServer(record.commandLine));
  for (const processRecord of candidates) {
    const listeningPorts = await getListeningPorts(processRecord.pid);
    const connection = parseRpcConnectionFromCommand(processRecord.commandLine, listeningPorts);
    if (connection) return connection;
  }
  return null;
}

function callRpc(connection: RpcConnection, method: string, payload: Record<string, unknown>): Promise<unknown | null> {
  const body = JSON.stringify(payload);

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: '127.0.0.1',
        port: connection.port,
        path: `/exa.language_server_pb.LanguageServerService/${method}`,
        method: 'POST',
        rejectUnauthorized: false,
        timeout: RPC_TIMEOUT_MS,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-codeium-csrf-token': connection.csrfToken,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        const MAX_RPC_RESPONSE_BYTES = 32 * 1024 * 1024;
        let aborted = false;
        res.on('data', (chunk: Buffer) => {
          if (aborted) return;
          receivedBytes += chunk.length;
          if (receivedBytes > MAX_RPC_RESPONSE_BYTES) {
            aborted = true;
            logger.debug('antigravity: RPC response exceeded cap', method, receivedBytes);
            req.destroy();
            resolve(null);
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          if (aborted) return;
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve(text ? JSON.parse(text) : null);
          } catch (err) {
            logger.debug('antigravity: failed to parse RPC response', method, err);
            resolve(null);
          }
        });
      },
    );

    req.on('error', (err) => {
      logger.debug('antigravity: RPC request failed', method, err);
      resolve(null);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end(body);
  });
}

async function discoverLiveRecords(records: Map<string, AntigravityRecord>): Promise<void> {
  const connection = await findRpcConnection();
  if (!connection) return;
  const response = await callRpc(connection, 'GetAllCascadeTrajectories', {});
  for (const [id, live] of parseLiveSummaryResponse(response)) {
    addRecord(records, id, { live });
  }
}

function normalizeModelName(model: string): string {
  return model
    .replace(/^MODEL_/u, '')
    .replace(/_/gu, '-')
    .toLowerCase();
}

function recordPreferredTitle(record: AntigravityRecord): string | undefined {
  return record.live?.title ?? record.state?.title ?? record.cli?.title;
}

export function extractUserRequestText(raw: string): string {
  const closedMatch = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/u);
  if (closedMatch?.[1] !== undefined) {
    return closedMatch[1].trim();
  }
  const openIdx = raw.indexOf('<USER_REQUEST>');
  if (openIdx !== -1) {
    return raw
      .slice(openIdx + '<USER_REQUEST>'.length)
      .replace(/<ADDITIONAL_METADATA>[\s\S]*/u, '')
      .replace(/<USER_SETTINGS_CHANGE>[\s\S]*/u, '')
      .trim();
  }
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gu, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gu, '')
    .trim();
}

export function extractModelFromSettingsChange(raw: string): string | undefined {
  const settingsMatch = raw.match(/<USER_SETTINGS_CHANGE>([\s\S]*?)<\/USER_SETTINGS_CHANGE>/u);
  const target = settingsMatch ? settingsMatch[1] : raw;
  const modelMatch = target.match(/setting\s+`Model Selection`\s+from\s+.+?\s+to\s+([^\n]+?)\.(?:\s|$)/u);
  return modelMatch?.[1]?.trim() || undefined;
}

async function scanTranscriptMetadata(filePath: string): Promise<TranscriptMetadata> {
  let stepCount = 0;
  let firstUserPrompt: string | undefined;
  let model: string | undefined;
  let createdAt: Date | undefined;
  let updatedAt: Date | undefined;
  let cwd: string | undefined;

  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const step: unknown = JSON.parse(trimmed);
        if (!isRecord(step)) continue;
        stepCount += 1;

        const ts = parseTimestamp(firstString(step, ['created_at', 'createdTime', 'timestamp']));
        if (ts) {
          if (!createdAt || ts.getTime() < createdAt.getTime()) createdAt = ts;
          if (!updatedAt || ts.getTime() > updatedAt.getTime()) updatedAt = ts;
        }

        const stepType = firstString(step, ['type']);
        if (stepType === 'USER_INPUT') {
          const content = firstString(step, ['content']) ?? '';
          const modelChange = extractModelFromSettingsChange(content);
          if (modelChange) model = modelChange;

          if (!firstUserPrompt) {
            const userText = extractUserRequestText(content);
            if (userText && !userText.startsWith('/')) {
              firstUserPrompt = userText;
            }
          }
        }
      } catch (err) {
        logger.debug('antigravity: skipping malformed transcript line during metadata scan', err);
      }
    }
  } catch (err) {
    logger.debug('antigravity: failed to scan transcript metadata', filePath, err);
  }

  return {
    stepCount,
    ...(firstUserPrompt ? { firstUserPrompt } : {}),
    ...(model ? { model } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

async function readArtifact(filePath: string): Promise<string | undefined> {
  try {
    const text = await fsp.readFile(filePath, 'utf8');
    return text.trim();
  } catch (err) {
    logger.debug('antigravity: failed to read artifact', filePath, err);
    return undefined;
  }
}

function firstMarkdownHeading(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const heading = line.match(/^#{1,6}\s+(.+)$/u)?.[1]?.trim();
    if (heading) return heading;
  }
  return undefined;
}

async function titleFromBrain(brainDir: string | undefined): Promise<string | undefined> {
  if (!brainDir) return undefined;
  for (const artifact of BRAIN_ARTIFACT_BASE_FILES) {
    const artifactPath = await findBrainArtifactPath(brainDir, artifact);
    if (!artifactPath) continue;
    const text = await readArtifact(artifactPath);
    if (!text) continue;
    return firstMarkdownHeading(text) ?? cleanSummary(text, 80);
  }
  return undefined;
}

async function inferCwdFromBrain(brainDir: string | undefined): Promise<string | undefined> {
  if (!brainDir) return undefined;
  for (const artifact of BRAIN_ARTIFACT_BASE_FILES) {
    const artifactPath = await findBrainArtifactPath(brainDir, artifact);
    if (!artifactPath) continue;
    const text = await readArtifact(artifactPath);
    if (!text) continue;
    const fileUri = text.match(/file:\/\/[^\s)\]'"`]+/u)?.[0];
    const cwd = fileUri ? decodeFileUri(fileUri) : undefined;
    if (cwd) return cwd;
  }
  return undefined;
}

async function pathStats(paths: string[]): Promise<{ bytes: number; createdAt?: Date; updatedAt?: Date }> {
  let bytes = 0;
  const createdTimes: number[] = [];
  const updatedTimes: number[] = [];

  for (const filePath of paths) {
    const stats = await statSafe(filePath);
    if (!stats) continue;
    bytes += stats.size;
    createdTimes.push(stats.birthtimeMs || stats.ctimeMs || stats.mtimeMs);
    updatedTimes.push(stats.mtimeMs);
  }

  return {
    bytes,
    ...(createdTimes.length > 0 ? { createdAt: new Date(Math.min(...createdTimes)) } : {}),
    ...(updatedTimes.length > 0 ? { updatedAt: new Date(Math.max(...updatedTimes)) } : {}),
  };
}

async function brainArtifactPaths(brainDir: string | undefined): Promise<string[]> {
  if (!brainDir) return [];
  const files: string[] = [];
  for (const fileName of BRAIN_ARTIFACT_BASE_FILES) {
    const filePath = await findBrainArtifactPath(brainDir, fileName);
    if (filePath) files.push(filePath);
  }
  return files;
}

async function buildSessionFromRecord(
  record: AntigravityRecord,
  options?: SessionParseOptions,
): Promise<UnifiedSession | null> {
  if (record.isSubagent) return null;
  if (record.legacyPath) return buildLegacySession(record.legacyPath, record.id);

  // Skip metadata-only records that have no concrete backing path; downstream
  // inspect/extract paths fs.statSync the originalPath, which would crash if
  // we emit a fallback to the (directory-only) antigravity root.
  if (!record.conversationPath && !record.brainDir && !record.transcriptPath) return null;

  const knownCwd = record.live?.cwd ?? record.state?.cwd ?? record.cli?.cwd;
  if (options?.cwd && knownCwd && !matchesCwd(knownCwd, options.cwd)) {
    return null;
  }

  const artifactPaths = await brainArtifactPaths(record.brainDir);
  if (
    !record.conversationPath &&
    !record.transcriptPath &&
    artifactPaths.length === 0 &&
    !record.state &&
    !record.live &&
    !record.cli?.stepCount
  ) {
    return null;
  }

  const transcriptMeta = record.compactTranscriptPath
    ? await scanTranscriptMetadata(record.compactTranscriptPath)
    : record.transcriptPath
      ? await scanTranscriptMetadata(record.transcriptPath)
      : undefined;

  if (
    transcriptMeta &&
    transcriptMeta.stepCount === 0 &&
    !record.conversationPath &&
    artifactPaths.length === 0 &&
    !record.cli?.stepCount
  ) {
    return null;
  }

  const stats = await pathStats(
    [record.transcriptPath, record.conversationPath, ...artifactPaths].filter(isNonEmptyString),
  );
  const title =
    recordPreferredTitle(record) ?? transcriptMeta?.firstUserPrompt ?? (await titleFromBrain(record.brainDir));
  const cwd = knownCwd ?? transcriptMeta?.cwd ?? (await inferCwdFromBrain(record.brainDir)) ?? '';

  if (options?.cwd && !matchesCwd(cwd, options.cwd)) {
    return null;
  }

  const createdAt =
    transcriptMeta?.createdAt ??
    record.live?.createdAt ??
    record.state?.createdAt ??
    record.cli?.createdAt ??
    stats.createdAt ??
    stats.updatedAt ??
    new Date(0);
  const updatedAt =
    record.live?.updatedAt ??
    record.state?.updatedAt ??
    record.cli?.updatedAt ??
    transcriptMeta?.updatedAt ??
    stats.updatedAt ??
    createdAt;
  const summary = cleanSummary(title ?? `Antigravity conversation ${record.id.slice(0, 8)}`, 80);
  const originalPath = record.transcriptPath ?? record.conversationPath ?? record.brainDir ?? getAntigravityRoot();
  const cliLines = Math.max(record.cli?.stepCount ?? 0, transcriptMeta?.stepCount ?? 0);
  const lines = record.live?.stepCount ?? record.state?.stepCount ?? (cliLines > 0 ? cliLines : artifactPaths.length);
  const model = record.live?.model ?? transcriptMeta?.model;

  return {
    id: record.id,
    source: SOURCE_NAME,
    cwd,
    repo: extractRepoFromCwd(cwd),
    lines,
    bytes: stats.bytes,
    createdAt,
    updatedAt,
    originalPath,
    summary,
    ...(model ? { model } : {}),
  };
}

async function buildLegacySession(filePath: string, prefixedId?: string): Promise<UnifiedSession | null> {
  const entries = await parseLegacySessionFile(filePath);
  const relevant = entries.filter((entry) => entry.type === 'user' || entry.type === 'assistant');
  if (relevant.length === 0) return null;

  const fileStats = await statSafe(filePath);
  const mtime = fileStats?.mtime ?? new Date();
  const ext = path.extname(filePath);
  const id = prefixedId ?? `legacy:${path.basename(filePath, ext)}`;
  const firstUser = relevant.find((entry) => entry.type === 'user');
  const createdAt = parseTimestamp(relevant[0].timestamp, mtime) ?? mtime;
  const updatedAt = parseTimestamp(relevant.at(-1)?.timestamp, mtime) ?? mtime;

  return {
    id,
    source: SOURCE_NAME,
    cwd: '',
    repo: 'antigravity',
    lines: relevant.length,
    bytes: fileStats?.size ?? 0,
    createdAt,
    updatedAt,
    originalPath: filePath,
    summary: firstUser ? cleanSummary(firstUser.content, 80) : `Antigravity legacy session ${id}`,
  };
}

async function discoverRecords(): Promise<Map<string, AntigravityRecord>> {
  const records = new Map<string, AntigravityRecord>();
  await discoverCliSummaryRecords(records);
  await discoverConversationRecords(records);
  await discoverBrainRecords(records);
  await discoverStateRecords(records);
  await discoverLiveRecords(records);
  await discoverLegacyRecords(records);
  return records;
}

export async function parseAntigravitySessions(options?: SessionParseOptions): Promise<UnifiedSession[]> {
  const records = await discoverRecords();
  const sessions: UnifiedSession[] = [];

  for (const record of records.values()) {
    const session = await buildSessionFromRecord(record, options);
    if (session) sessions.push(session);
  }

  const sorted = sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return options?.limit && options.limit > 0 ? sorted.slice(0, options.limit) : sorted;
}

async function readLegacyMessages(filePath: string, fallbackDate: Date): Promise<ConversationMessage[]> {
  const entries = await parseLegacySessionFile(filePath);
  const messages: ConversationMessage[] = [];

  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'assistant') continue;
    messages.push({
      role: entry.type,
      content: entry.content,
      timestamp: parseTimestamp(entry.timestamp, fallbackDate),
    });
  }

  return messages;
}

function extractSessionId(session: UnifiedSession): string {
  return session.id.startsWith('legacy:') ? session.id.slice('legacy:'.length) : session.id;
}

async function resolveBrainDirForSession(session: UnifiedSession): Promise<string | undefined> {
  const id = extractSessionId(session);
  for (const root of getAntigravityRoots()) {
    const direct = path.join(root, 'brain', id);
    if (await exists(direct)) return direct;
  }
  if (session.originalPath.endsWith('.jsonl')) {
    const candidate = path.resolve(path.dirname(session.originalPath), '..', '..');
    if (path.basename(candidate) === id && (await exists(candidate))) return candidate;
  }
  const maybeRecordDir = path.dirname(session.originalPath);
  if (path.basename(maybeRecordDir) === id && (await hasBrainArtifacts(maybeRecordDir))) return maybeRecordDir;
  return undefined;
}

async function resolveTranscriptForSession(session: UnifiedSession): Promise<string | undefined> {
  if (session.originalPath.endsWith('.jsonl') && !session.id.startsWith('legacy:')) {
    if (await exists(session.originalPath)) return session.originalPath;
  }
  const brainDir = await resolveBrainDirForSession(session);
  if (!brainDir) return undefined;
  const transcripts = await findTranscriptPaths(brainDir);
  return transcripts?.transcriptPath;
}

function taskFromMarkdown(markdown: string): string | undefined {
  const heading = firstMarkdownHeading(markdown);
  if (heading) return heading;
  return cleanSummary(markdown, 100);
}

function pendingTasksFromMarkdown(markdown: string): string[] {
  const tasks: string[] = [];
  for (const line of markdown.split('\n')) {
    const match = line.match(/^\s*[-*]\s+\[(?: |todo|pending|in_progress)\]\s+(.+)$/iu);
    if (match?.[1]) tasks.push(match[1].trim());
  }
  return tasks;
}

async function readOfflineArtifacts(brainDir: string | undefined): Promise<{
  messages: ConversationMessage[];
  pendingTasks: string[];
  compactSummary?: string;
}> {
  if (!brainDir) {
    return {
      messages: [],
      pendingTasks: [],
      compactSummary:
        'Antigravity stores the persisted transcript in conversation .pb files. Start Antigravity to extract full live steps; offline handoff artifacts were not available for this session.',
    };
  }

  const messages: ConversationMessage[] = [];
  const pendingTasks: string[] = [];
  const compactParts: string[] = [];
  const taskPath = await findBrainArtifactPath(brainDir, 'task.md');
  const planPath = await findBrainArtifactPath(brainDir, 'implementation_plan.md');
  const walkthroughPath = await findBrainArtifactPath(brainDir, 'walkthrough.md');
  const task = taskPath ? await readArtifact(taskPath) : undefined;
  const plan = planPath ? await readArtifact(planPath) : undefined;
  const walkthrough = walkthroughPath ? await readArtifact(walkthroughPath) : undefined;

  if (task) {
    messages.push({ role: 'user', content: taskFromMarkdown(task) ?? task });
    pendingTasks.push(...pendingTasksFromMarkdown(task));
    compactParts.push(`Task artifact: ${cleanSummary(task, 180)}`);
  }
  if (plan) {
    messages.push({ role: 'assistant', content: `Implementation plan:\n\n${plan}` });
    pendingTasks.push(...pendingTasksFromMarkdown(plan));
    compactParts.push('implementation_plan.md is available in the Antigravity brain folder.');
  }
  if (walkthrough) {
    messages.push({ role: 'assistant', content: `Walkthrough:\n\n${walkthrough}` });
    pendingTasks.push(...pendingTasksFromMarkdown(walkthrough));
    compactParts.push('walkthrough.md is available in the Antigravity brain folder.');
  }

  return {
    messages,
    pendingTasks: Array.from(new Set(pendingTasks)),
    compactSummary:
      compactParts.length > 0
        ? `${compactParts.join(' ')} Full raw transcript extraction requires the running Antigravity language server.`
        : 'Full raw transcript extraction requires the running Antigravity language server.',
  };
}

function parsePromptMessages(raw: unknown): ConversationMessage[] {
  if (!Array.isArray(raw)) return [];
  const messages: ConversationMessage[] = [];

  for (const item of raw) {
    if (!isRecord(item)) continue;
    const prompt = firstString(item, ['prompt', 'content', 'text']);
    if (!prompt) continue;
    const source = firstString(item, ['source', 'role']) ?? '';
    const role: ConversationMessage['role'] =
      source === 'CHAT_MESSAGE_SOURCE_USER' || source === 'user'
        ? 'user'
        : source === 'CHAT_MESSAGE_SOURCE_SYSTEM' || source === 'system'
          ? 'system'
          : 'assistant';
    messages.push({ role, content: prompt });
  }

  return messages;
}

function getTailMessagesFromTrajectory(
  trajectory: Record<string, unknown>,
  stepMessages: ConversationMessage[],
): ConversationMessage[] {
  const metadata = Array.isArray(trajectory.generatorMetadata) ? trajectory.generatorMetadata : [];
  let prompts: unknown[] | undefined;

  for (let index = metadata.length - 1; index >= 0; index -= 1) {
    const item = metadata[index];
    if (!isRecord(item)) continue;
    const chatModel = recordAt(item, 'chatModel');
    const messagePrompts = chatModel.messagePrompts;
    if (Array.isArray(messagePrompts) && messagePrompts.length > 0) {
      prompts = messagePrompts;
      break;
    }
  }

  if (!prompts) return [];
  const promptMessages = parsePromptMessages(prompts);
  const lastUser = [...stepMessages]
    .reverse()
    .find((message) => message.role === 'user' && message.content.length > 20);
  if (!lastUser) return [];
  const needle = lastUser.content.slice(0, 50);
  let matchIndex = -1;
  for (let index = promptMessages.length - 1; index >= 0; index -= 1) {
    const message = promptMessages[index];
    if (message.role === 'user' && message.content.includes(needle)) {
      matchIndex = index;
      break;
    }
  }
  if (matchIndex < 0 || matchIndex >= promptMessages.length - 1) return [];
  return promptMessages.slice(matchIndex + 1);
}

function parseToolArguments(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) return raw;
  if (isNonEmptyString(raw)) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      return { value: raw };
    }
  }
  return undefined;
}

export function normalizeCliToolArgs(raw: unknown): Record<string, unknown> | undefined {
  const base = parseToolArguments(raw);
  if (!base) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
        (trimmed.startsWith('[') && trimmed.endsWith(']'))
      ) {
        try {
          normalized[key] = JSON.parse(trimmed);
          continue;
        } catch {
          // Keep original string if not valid JSON
        }
      }
    }
    normalized[key] = value;
  }
  return normalized;
}

function extractTextItems(items: unknown): string {
  if (!Array.isArray(items)) return '';
  return items
    .map((item) => {
      if (!isRecord(item)) return '';
      return firstString(item, ['text', 'content', 'prompt']) ?? '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function extractFilePath(record: Record<string, unknown>): string | undefined {
  const direct = firstString(record, [
    'Path',
    'TargetFile',
    'filePath',
    'file_path',
    'path',
    'absolutePath',
    'workspacePath',
    'DirectoryPath',
    'SearchPath',
  ]);
  if (direct) return normalizeCwd(direct) ?? direct;

  for (const value of Object.values(record)) {
    if (isRecord(value)) {
      const nested = extractFilePath(value);
      if (nested) return nested;
    }
  }

  return undefined;
}

function parseLineDiffStatsFromResult(result: string | undefined): { added: number; removed: number } | undefined {
  if (!result) return undefined;
  const match = result.match(/\(\+(\d+)\/-(\d+)\s+lines?\)/iu);
  if (!match) return undefined;
  return { added: Number(match[1]), removed: Number(match[2]) };
}

function extractCommandStdoutTail(result: string | undefined, maxLines = 5): string | undefined {
  if (!result) return undefined;
  const marker = 'Command output:';
  const idx = result.indexOf(marker);
  const body = (idx !== -1 ? result.slice(idx + marker.length) : result).trim();
  if (!body) return undefined;
  const lines = body.split('\n');
  return lines.slice(-maxLines).join('\n').slice(-500);
}

function summarizeCliToolCall(toolCall: ToolCall, collector: SummaryCollector, config: VerbosityConfig): void {
  const name = toolCall.name;
  if (SKIP_TOOLS.has(name)) return;

  const args = toolCall.arguments ?? {};
  const result = toolCall.result;
  const isError = toolCall.success === false;

  if (SHELL_TOOLS.has(name)) {
    const command = firstString(args, ['CommandLine', 'command', 'commandLine', 'cmd']);
    if (!command) return;
    const exitCode = extractExitCode(result);
    const stdoutTail = extractCommandStdoutTail(result, config.shell.stdoutLines);
    const errored = isError || (exitCode !== undefined && exitCode !== 0);
    collector.add('Bash', shellSummary(command, result), {
      data: {
        category: 'shell',
        command,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(stdoutTail ? { stdoutTail } : {}),
        ...(errored ? { errored: true, ...(stdoutTail ? { errorMessage: stdoutTail.slice(0, 200) } : {}) } : {}),
      },
      isError: errored,
    });
    return;
  }

  if (READ_TOOLS.has(name)) {
    const filePath = extractFilePath(args);
    if (!filePath) return;
    const lineStart = firstNumber(args, ['StartLine', 'startLine', 'lineStart', 'offset']);
    const lineEnd = firstNumber(args, ['EndLine', 'endLine', 'lineEnd', 'limit']);
    collector.add('Read', fileSummary('read', filePath), {
      data: {
        category: 'read',
        filePath,
        ...(lineStart !== undefined ? { lineStart } : {}),
        ...(lineEnd !== undefined ? { lineEnd } : {}),
      },
      filePath,
      isError,
    });
    return;
  }

  if (WRITE_TOOLS.has(name)) {
    const filePath = extractFilePath(args);
    if (!filePath) return;
    const content = firstString(args, ['Content', 'content', 'fileText', 'CodeContent']);
    const diffStats =
      parseLineDiffStatsFromResult(result) ??
      (content !== undefined ? { added: content.split('\n').length, removed: 0 } : undefined);
    const isNewFile = result ? /^Created\b/iu.test(result.trim()) : true;
    collector.add('Write', fileSummary('write', filePath, diffStats, isNewFile), {
      data: {
        category: 'write',
        filePath,
        isNewFile,
        ...(diffStats ? { diffStats } : {}),
        ...(isError && result ? { errorMessage: result.slice(0, 200) } : {}),
      },
      filePath,
      isWrite: true,
      isError,
    });
    return;
  }

  if (EDIT_TOOLS.has(name)) {
    const filePath = extractFilePath(args);
    if (!filePath) return;
    const target = firstString(args, ['Target', 'TargetContent', 'old_string', 'oldString']);
    const replacement = firstString(args, ['Replacement', 'ReplacementContent', 'new_string', 'newString']);
    const diffStats =
      parseLineDiffStatsFromResult(result) ??
      (target !== undefined && replacement !== undefined
        ? { added: replacement.split('\n').length, removed: target.split('\n').length }
        : undefined);
    collector.add('Edit', fileSummary('edit', filePath, diffStats), {
      data: {
        category: 'edit',
        filePath,
        ...(diffStats ? { diffStats } : {}),
        ...(isError && result ? { errorMessage: result.slice(0, 200) } : {}),
      },
      filePath,
      isWrite: true,
      isError,
    });
    return;
  }

  if (GREP_TOOLS.has(name)) {
    const pattern = firstString(args, ['Query', 'query', 'pattern', 'Pattern']) ?? '';
    const targetPath = normalizeCwd(firstString(args, ['SearchPath', 'searchPath', 'Path', 'path', 'DirectoryPath']));
    collector.add('Grep', grepSummary(pattern, targetPath), {
      data: {
        category: 'grep',
        pattern,
        ...(targetPath ? { targetPath } : {}),
      },
      isError,
    });
    return;
  }

  if (GLOB_TOOLS.has(name)) {
    const pattern =
      firstString(args, ['Pattern', 'pattern', 'DirectoryPath', 'SearchDirectory', 'Path', 'path']) ?? '.';
    collector.add('Glob', globSummary(pattern), {
      data: {
        category: 'glob',
        pattern,
      },
      isError,
    });
    return;
  }

  if (SEARCH_TOOLS.has(name)) {
    const query = firstString(args, ['query', 'Query']) ?? '';
    const resultPreview = stringifyPreview(result, 100);
    collector.add('WebSearch', searchSummary(query), {
      data: {
        category: 'search',
        query,
        ...(resultPreview ? { resultPreview } : {}),
      },
      isError,
    });
    return;
  }

  if (FETCH_TOOLS.has(name)) {
    const url = firstString(args, ['url', 'Url', 'URL']) ?? '';
    const resultPreview = stringifyPreview(result, 100);
    collector.add('WebFetch', fetchSummary(url), {
      data: {
        category: 'fetch',
        url,
        ...(resultPreview ? { resultPreview } : {}),
      },
      isError,
    });
    return;
  }

  if (TASK_TOOLS.has(name)) {
    const description = firstString(args, ['Role', 'description', 'Prompt', 'prompt']) ?? 'subagent';
    const agentType = firstString(args, ['TypeName', 'subagent_type', 'type']);
    const resultSummary = stringifyPreview(result, 100);
    collector.add('Task', subagentSummary(description, agentType), {
      data: {
        category: 'task',
        description,
        ...(agentType ? { agentType } : {}),
        ...(resultSummary ? { resultSummary } : {}),
      },
      isError,
    });
    return;
  }

  if (ASK_TOOLS.has(name)) {
    let question = firstString(args, ['question', 'Question']);
    if (!question && Array.isArray(args.questions) && isRecord(args.questions[0])) {
      question = firstString(args.questions[0], ['question', 'Question']);
    }
    question ??= 'user question';
    collector.add('AskUserQuestion', `ask "${truncate(question, 60)}"`, {
      data: {
        category: 'ask',
        question: truncate(question, 80),
      },
      isError,
    });
    return;
  }

  summarizeGenericTool(name, args, result, collector, isError);
}

function summarizeGenericTool(
  toolName: string,
  input: unknown,
  result: unknown,
  collector: SummaryCollector,
  isError = false,
): void {
  const params = stringifyPreview(input, 100);
  const resultPreview = stringifyPreview(result, 100);
  collector.add(toolName, mcpSummary(toolName, params ?? '', resultPreview), {
    data: {
      category: 'mcp',
      toolName,
      ...(params ? { params } : {}),
      ...(resultPreview ? { result: resultPreview } : {}),
    },
    isError,
  });
}

function summarizeToolStep(type: string, stepData: Record<string, unknown>, collector: SummaryCollector): void {
  if (type === 'CORTEX_STEP_TYPE_RUN_COMMAND') {
    const command = firstString(stepData, ['command', 'commandLine', 'cmd']);
    if (!command) return;
    const output = firstString(stepData, ['output', 'stdout', 'stderr', 'result']);
    collector.add('run_command', shellSummary(command, output), {
      data: { category: 'shell', command, ...(output ? { stdoutTail: output.slice(-500) } : {}) },
    });
    return;
  }

  if (type === 'CORTEX_STEP_TYPE_VIEW_FILE') {
    const filePath = extractFilePath(stepData);
    if (!filePath) return;
    collector.add('view_file', fileSummary('read', filePath), {
      data: { category: 'read', filePath },
    });
    return;
  }

  const toolName =
    firstString(stepData, ['toolName', 'name', 'displayName']) ?? type.replace(/^CORTEX_STEP_TYPE_/u, '').toLowerCase();
  const input = stepData.input ?? stepData.args ?? stepData.arguments;
  const result = stepData.output ?? stepData.result ?? stepData.error;
  const filePath = extractFilePath(stepData);
  const patch = firstString(stepData, ['patch', 'diff', 'textDiff']);

  if (filePath && /write|edit|patch|replace|create/iu.test(toolName)) {
    const diffStats = patch ? countDiffStats(patch) : undefined;
    collector.add(toolName, fileSummary(patch ? 'edit' : 'write', filePath, diffStats), {
      data: {
        category: patch ? 'edit' : 'write',
        filePath,
        ...(patch ? { diff: patch.slice(0, 2000), diffStats } : {}),
      },
      filePath,
      isWrite: true,
      isError: isNonEmptyString(stepData.error),
    });
    return;
  }

  summarizeGenericTool(toolName, input, result, collector, isNonEmptyString(stepData.error));
}

function parseStepTimestamp(step: Record<string, unknown>, fallback: Date): Date {
  const meta = recordAt(step, 'metadata');
  return (
    parseTimestamp(firstString(step, ['createdTime', 'timestamp', 'startTime'])) ??
    parseTimestamp(firstString(meta, ['createdTime', 'timestamp', 'startTime'])) ??
    dateFromEpoch(firstNumber(step, ['createdAt', 'timeCreated'])) ??
    fallback
  );
}

function extractPlannerMessage(
  step: Record<string, unknown>,
  timestamp: Date,
  sessionNotes: SessionNotes,
): ConversationMessage | null {
  const plannerResponse = recordAt(step, 'plannerResponse');
  if (Object.keys(plannerResponse).length === 0) return null;

  const thinking = firstString(plannerResponse, ['thinking', 'thought', 'reasoning']);
  if (thinking) {
    sessionNotes.reasoning ??= [];
    if (sessionNotes.reasoning.length < 10) sessionNotes.reasoning.push(truncate(thinking, 500));
  }

  const content = firstString(plannerResponse, ['modifiedResponse', 'response', 'textContent', 'content', 'text']);
  const toolCalls: NonNullable<ConversationMessage['toolCalls']> = [];
  const rawToolCalls = plannerResponse.toolCalls;
  if (Array.isArray(rawToolCalls)) {
    for (const toolCall of rawToolCalls) {
      if (!isRecord(toolCall)) continue;
      const name = firstString(toolCall, ['name', 'toolName']);
      if (!name) continue;
      const args = parseToolArguments(toolCall.argumentsJson ?? toolCall.arguments ?? toolCall.args);
      toolCalls.push({
        name,
        ...(firstString(toolCall, ['id', 'callId']) ? { id: firstString(toolCall, ['id', 'callId']) } : {}),
        ...(args ? { arguments: args } : {}),
      });
    }
  }

  if (!content && toolCalls.length === 0) return null;
  return {
    role: 'assistant',
    content: content ?? `[tool calls: ${toolCalls.map((toolCall) => toolCall.name).join(', ')}]`,
    timestamp,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}

function extractUserMessage(step: Record<string, unknown>, timestamp: Date): ConversationMessage | null {
  const userInput = recordAt(step, 'userInput');
  const askUserQuestion = recordAt(step, 'askUserQuestion');
  const source = Object.keys(userInput).length > 0 ? userInput : askUserQuestion;
  const text =
    firstString(source, ['userResponse', 'question', 'text', 'content', 'prompt']) || extractTextItems(source.items);
  return text ? { role: 'user', content: text, timestamp } : null;
}

function stepDataForType(type: string, step: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case 'CORTEX_STEP_TYPE_RUN_COMMAND':
      return recordAt(step, 'runCommand');
    case 'CORTEX_STEP_TYPE_COMMAND_STATUS':
      return recordAt(step, 'commandStatus');
    case 'CORTEX_STEP_TYPE_VIEW_FILE':
      return recordAt(step, 'viewFile');
    case 'CORTEX_STEP_TYPE_TOOL_EXECUTION':
      return recordAt(step, 'toolExecution');
    default:
      return step;
  }
}

function extractPendingFromText(text: string, limit: number): string[] {
  return pendingTasksFromMarkdown(text).slice(0, limit);
}

function extractFromSteps(steps: unknown[], config: VerbosityConfig, fallbackDate: Date): RpcStepExtraction {
  const messages: ConversationMessage[] = [];
  const collector = new SummaryCollector(config);
  const pendingTasks: string[] = [];
  const sessionNotes: SessionNotes = {};

  for (const rawStep of steps) {
    if (!isRecord(rawStep)) continue;
    const type = firstString(rawStep, ['type']) ?? '';
    const timestamp = parseStepTimestamp(rawStep, fallbackDate);

    if (type === 'CORTEX_STEP_TYPE_USER_INPUT' || type === 'CORTEX_STEP_TYPE_ASK_USER_QUESTION') {
      const message = extractUserMessage(rawStep, timestamp);
      if (message) messages.push(message);
      continue;
    }

    if (type === 'CORTEX_STEP_TYPE_PLANNER_RESPONSE') {
      const message = extractPlannerMessage(rawStep, timestamp, sessionNotes);
      if (message) {
        messages.push(message);
        pendingTasks.push(...extractPendingFromText(message.content, config.pendingTasks.maxTasks));
      }
      continue;
    }

    if (
      type === 'CORTEX_STEP_TYPE_RUN_COMMAND' ||
      type === 'CORTEX_STEP_TYPE_COMMAND_STATUS' ||
      type === 'CORTEX_STEP_TYPE_VIEW_FILE' ||
      type === 'CORTEX_STEP_TYPE_TOOL_EXECUTION'
    ) {
      summarizeToolStep(type, stepDataForType(type, rawStep), collector);
    }
  }

  return {
    messages,
    filesModified: collector.getFilesModified(),
    toolSummaries: collector.getSummaries(),
    pendingTasks: Array.from(new Set(pendingTasks)).slice(0, config.pendingTasks.maxTasks),
    sessionNotes: Object.keys(sessionNotes).length > 0 ? sessionNotes : undefined,
  };
}

async function extractTranscriptContext(
  session: UnifiedSession,
  transcriptPath: string,
  config: VerbosityConfig,
): Promise<RpcStepExtraction | null> {
  const messages: ConversationMessage[] = [];
  const collector = new SummaryCollector(config);
  const pendingTasks: string[] = [];
  const sessionNotes: SessionNotes = {};
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let pendingToolCalls: ToolCall[] = [];

  const flushPendingToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    for (const tc of pendingToolCalls) {
      summarizeCliToolCall(tc, collector, config);
    }
    pendingToolCalls = [];
  };

  try {
    const stream = fs.createReadStream(transcriptPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let step: unknown;
      try {
        step = JSON.parse(trimmed);
      } catch (err) {
        logger.debug('antigravity: skipping malformed transcript JSONL line', err);
        continue;
      }

      if (!isRecord(step)) continue;
      const type = firstString(step, ['type']) ?? '';

      if (type !== 'GENERIC' && pendingToolCalls.length > 0) {
        flushPendingToolCalls();
      }

      inputTokens += firstNumber(step, ['input_tokens']) ?? 0;
      outputTokens += firstNumber(step, ['output_tokens']) ?? 0;
      cacheReadTokens += firstNumber(step, ['cache_read_tokens']) ?? 0;

      const timestamp =
        parseTimestamp(firstString(step, ['created_at', 'createdTime', 'timestamp']), session.updatedAt) ??
        session.updatedAt;

      if (type === 'USER_INPUT') {
        const rawContent = firstString(step, ['content']) ?? '';
        const modelChange = extractModelFromSettingsChange(rawContent);
        if (modelChange) {
          sessionNotes.model = modelChange;
          if (!session.model) session.model = modelChange;
        }

        const userText = extractUserRequestText(rawContent);
        if (userText) {
          messages.push({ role: 'user', content: userText, timestamp });
        } else if (Array.isArray(step.media) && step.media.length > 0) {
          messages.push({ role: 'user', content: '[attached media]', timestamp });
        }
        continue;
      }

      if (type === 'PLANNER_RESPONSE') {
        const thinking = firstString(step, ['thinking', 'thought', 'reasoning']);
        if (thinking) {
          sessionNotes.reasoning ??= [];
          if (sessionNotes.reasoning.length < 10) {
            sessionNotes.reasoning.push(truncate(thinking, 500));
          }
        }

        const content = firstString(step, ['content', 'response', 'text']);
        if (content) {
          pendingTasks.push(...extractPendingFromText(content, config.pendingTasks.maxTasks));
        }

        const toolCalls: ToolCall[] = [];
        if (Array.isArray(step.tool_calls)) {
          for (const rawTc of step.tool_calls) {
            if (!isRecord(rawTc)) continue;
            const name = firstString(rawTc, ['name', 'toolName']);
            if (!name) continue;
            const args = normalizeCliToolArgs(rawTc.args ?? rawTc.arguments ?? rawTc.argumentsJson);
            const id = firstString(rawTc, ['id', 'callId']);
            toolCalls.push({
              name,
              ...(id ? { id } : {}),
              ...(args ? { arguments: args } : {}),
            });
          }
        }

        if (content || toolCalls.length > 0) {
          messages.push({
            role: 'assistant',
            content: content ?? `[tool calls: ${toolCalls.map((tc) => tc.name).join(', ')}]`,
            timestamp,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }

        pendingToolCalls = [...toolCalls];
        continue;
      }

      if (type === 'GENERIC') {
        const currentTc = pendingToolCalls.shift();
        if (currentTc) {
          const result = firstString(step, ['content', 'output', 'result']);
          const status = firstString(step, ['status']);
          if (result) currentTc.result = result;
          if (status) currentTc.success = status !== 'ERROR' && status !== 'FAILED' && status !== 'CANCELED';
          summarizeCliToolCall(currentTc, collector, config);
        }
        continue;
      }

      if (type === 'CHECKPOINT') {
        const rawContent = firstString(step, ['content']) ?? '';
        const summaryMatch = rawContent.match(/<summary>\s*([\s\S]*?)\s*<\/summary>/u);
        const summaryText = (summaryMatch?.[1] ?? rawContent).trim();
        if (summaryText) {
          sessionNotes.compactSummary = truncate(summaryText, 2000);
          pendingTasks.push(...extractPendingFromText(summaryText, config.pendingTasks.maxTasks));
        }
      }
    }

    flushPendingToolCalls();
  } catch (err) {
    logger.debug('antigravity: failed to extract CLI transcript context', transcriptPath, err);
    return null;
  }

  const brainDir = await resolveBrainDirForSession(session);
  if (brainDir) {
    for (const baseName of ['task.md', 'implementation_plan.md']) {
      const artifactPath = await findBrainArtifactPath(brainDir, baseName);
      if (!artifactPath) continue;
      const text = await readArtifact(artifactPath);
      if (text) {
        pendingTasks.push(...pendingTasksFromMarkdown(text));
      }
    }
  }

  if (inputTokens > 0 || outputTokens > 0) {
    sessionNotes.tokenUsage = { input: inputTokens, output: outputTokens };
  }
  if (cacheReadTokens > 0) {
    sessionNotes.cacheTokens = { creation: 0, read: cacheReadTokens };
  }

  return {
    messages,
    filesModified: collector.getFilesModified(),
    toolSummaries: collector.getSummaries(),
    pendingTasks: Array.from(new Set(pendingTasks)).slice(0, config.pendingTasks.maxTasks),
    sessionNotes: Object.keys(sessionNotes).length > 0 ? sessionNotes : undefined,
  };
}

function extractStepsResponse(response: unknown): unknown[] {
  if (!isRecord(response)) return [];
  if (Array.isArray(response.steps)) return response.steps;
  const trajectory = recordAt(response, 'trajectory');
  if (Array.isArray(trajectory.steps)) return trajectory.steps;
  return [];
}

async function extractLiveContext(
  session: UnifiedSession,
  config: VerbosityConfig,
  preconnected?: RpcConnection,
): Promise<RpcStepExtraction | null> {
  const connection = preconnected ?? (await findRpcConnection());
  if (!connection) return null;

  const cascadeId = extractSessionId(session);
  const stepsResponse = await callRpc(connection, 'GetCascadeTrajectorySteps', { cascadeId });
  let steps = extractStepsResponse(stepsResponse);
  let trajectory: Record<string, unknown> | undefined;

  if (steps.length === 0) {
    const fallbackResponse = await callRpc(connection, 'GetCascadeTrajectory', { cascadeId });
    if (isRecord(fallbackResponse)) {
      trajectory = recordAt(fallbackResponse, 'trajectory');
      steps = extractStepsResponse(fallbackResponse);
    }
  } else {
    const trajectoryResponse = await callRpc(connection, 'GetCascadeTrajectory', { cascadeId });
    if (isRecord(trajectoryResponse)) trajectory = recordAt(trajectoryResponse, 'trajectory');
  }

  if (steps.length === 0) return null;
  const extracted = extractFromSteps(steps, config, session.updatedAt);
  if (trajectory) {
    const tail = getTailMessagesFromTrajectory(trajectory, extracted.messages);
    if (tail.length > 0) extracted.messages.push(...tail);
  }
  return extracted;
}

function liveHasContent(live: RpcStepExtraction): boolean {
  return (
    live.messages.length > 0 ||
    live.toolSummaries.length > 0 ||
    live.filesModified.length > 0 ||
    live.pendingTasks.length > 0 ||
    Boolean(live.sessionNotes)
  );
}

function buildLiveSessionContext(
  session: UnifiedSession,
  live: RpcStepExtraction,
  config: VerbosityConfig,
): SessionContext {
  const recentMessages = trimMessages(live.messages, config.recentMessages);
  const sessionNotes = live.sessionNotes;
  const markdown = generateHandoffMarkdown(
    session,
    recentMessages,
    live.filesModified,
    live.pendingTasks,
    live.toolSummaries,
    sessionNotes,
    config,
  );
  return {
    session,
    recentMessages,
    filesModified: live.filesModified,
    pendingTasks: live.pendingTasks,
    toolSummaries: live.toolSummaries,
    sessionNotes,
    markdown,
  };
}

function shouldAutoLaunchAntigravity(): boolean {
  // Test/CI escape hatch — also honored by findRpcConnection.
  if (process.env.ANTIGRAVITY_DISABLE_RPC === '1') return false;
  const explicit = process.env.CONTINUES_LAUNCH_ANTIGRAVITY?.trim();
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  if (explicit === '1' || explicit === 'true' || explicit === 'yes') return true;
  // Default: only auto-launch in interactive terminals so piped/CI runs stay headless.
  return Boolean(process.stdout.isTTY);
}

function spawnAntigravity(): boolean {
  try {
    let child: childProcess.ChildProcess;
    if (process.platform === 'darwin') {
      child = childProcess.spawn('open', ['-a', 'Antigravity'], { detached: true, stdio: 'ignore' });
    } else if (process.platform === 'win32') {
      child = childProcess.spawn('cmd', ['/c', 'start', '', 'antigravity'], { detached: true, stdio: 'ignore' });
    } else {
      child = childProcess.spawn('antigravity', [], { detached: true, stdio: 'ignore' });
    }
    // node emits launch failures (e.g. ENOENT when the binary is missing) on
    // the async 'error' event, not synchronously. without this listener an
    // uncaught exception would crash the cli and skip the offline fallback.
    // mirrors the pattern used in src/utils/resume.ts.
    child.on('error', (err) => {
      logger.debug('antigravity: spawned IDE process error', err);
    });
    child.unref();
    return true;
  } catch (err) {
    logger.debug('antigravity: failed to spawn IDE', err);
    return false;
  }
}

async function pollForRpcConnection(timeoutMs: number, intervalMs: number): Promise<RpcConnection | null> {
  const deadline = Date.now() + timeoutMs;
  // Probe immediately — language_server may already be coming up from a prior launch.
  const initial = await findRpcConnection();
  if (initial) return initial;

  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
    const connection = await findRpcConnection();
    if (connection) return connection;
  }
  return null;
}

async function tryAutoLaunchAndConnect(): Promise<RpcConnection | null> {
  if (!shouldAutoLaunchAntigravity()) return null;

  // gate the spawn on rpc actually being offline. extractLiveContext returns
  // null both when (a) the language_server is down and (b) it's up but holds
  // no steps for this cascadeId (evicted trajectory). launching the ide can
  // only help case (a); in case (b) it would just bounce the user's dock for
  // nothing. skipping the spawn here lets us fall straight to the offline
  // brain-artifact path, which is what we want.
  const existing = await findRpcConnection();
  if (existing) return null;

  if (!spawnAntigravity()) {
    logger.warn('antigravity: could not launch Antigravity — falling back to offline brain artifacts.');
    return null;
  }

  // these progress messages are user-facing ux during a blocking operation
  // (up to 25s while the ide spins up) rather than diagnostic output, but we
  // still route them through the logger to honor the project convention. by
  // default the logger is silent, so casual users won't see anything; running
  // with --verbose surfaces the full launching/connected/timeout sequence.
  logger.warn(
    'antigravity: language server is offline — launching the IDE to read the encrypted transcript… ' +
      '(set CONTINUES_LAUNCH_ANTIGRAVITY=0 to skip)',
  );

  const timeoutMs = getLaunchTimeoutMs();
  const start = Date.now();
  const connection = await pollForRpcConnection(timeoutMs, getLaunchPollIntervalMs());
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  if (connection) {
    logger.warn(`antigravity: language server connected in ${elapsed}s.`);
    return connection;
  }

  logger.warn(
    `antigravity: language server did not come online within ${timeoutMs / 1000}s — falling back to offline brain artifacts.`,
  );
  return null;
}

async function extractOfflineContext(session: UnifiedSession, config: VerbosityConfig): Promise<SessionContext> {
  const brainDir = await resolveBrainDirForSession(session);
  const artifacts = await readOfflineArtifacts(brainDir);
  const messages = trimMessages(artifacts.messages, config.recentMessages);
  const sessionNotes: SessionNotes = {
    compactSummary: artifacts.compactSummary,
  };
  const pendingTasks = artifacts.pendingTasks.slice(0, config.pendingTasks.maxTasks);
  const markdown = generateHandoffMarkdown(session, messages, [], pendingTasks, [], sessionNotes, config);

  return {
    session,
    recentMessages: messages,
    filesModified: [],
    pendingTasks,
    toolSummaries: [],
    sessionNotes,
    markdown,
  };
}

export async function extractAntigravityContext(
  session: UnifiedSession,
  config?: VerbosityConfig,
): Promise<SessionContext> {
  const resolvedConfig = config ?? getPreset('standard');

  if (session.id.startsWith('legacy:')) {
    const messages = await readLegacyMessages(session.originalPath, session.updatedAt);
    const recentMessages = trimMessages(messages, resolvedConfig.recentMessages);
    const markdown = generateHandoffMarkdown(session, recentMessages, [], [], [], undefined, resolvedConfig);
    return {
      session,
      recentMessages,
      filesModified: [],
      pendingTasks: [],
      toolSummaries: [],
      sessionNotes: undefined,
      markdown,
    };
  }

  // Antigravity CLI (agy) stores unencrypted JSONL transcripts under
  // brain/<id>/.system_generated/logs/transcript_full.jsonl. Prefer reading the
  // transcript directly without connecting to or launching the IDE.
  const transcriptPath = await resolveTranscriptForSession(session);
  if (transcriptPath) {
    const transcriptExtracted = await extractTranscriptContext(session, transcriptPath, resolvedConfig);
    if (transcriptExtracted && liveHasContent(transcriptExtracted)) {
      return buildLiveSessionContext(session, transcriptExtracted, resolvedConfig);
    }
  }

  const live = await extractLiveContext(session, resolvedConfig);
  if (live && liveHasContent(live)) {
    return buildLiveSessionContext(session, live, resolvedConfig);
  }

  // Antigravity IDE stores conversation .pb files as encrypted blobs — only the
  // running language_server holds the decryption key. If it's offline, try to
  // launch the IDE in the foreground and aggressively poll for the RPC port to
  // come up so we can produce a real transcript instead of empty handoffs.
  const connection = await tryAutoLaunchAndConnect();
  if (connection) {
    const relaunched = await extractLiveContext(session, resolvedConfig, connection);
    if (relaunched && liveHasContent(relaunched)) {
      return buildLiveSessionContext(session, relaunched, resolvedConfig);
    }
  }

  return extractOfflineContext(session, resolvedConfig);
}
