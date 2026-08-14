/**
 * GitHub Contents API client with hard download safety limits.
 *
 * Every request is bounded by {@link HTTP_TIMEOUT_MS} and the caller's
 * AbortSignal. Recursive downloads enforce the file-size, total-size,
 * file-count, recursion-depth, and path-escape limits that keep a hostile or
 * broken remote bundle from exhausting disk or escaping its install root.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteSkillSource } from './url.ts'

/** Single-file cap: 1 MiB. */
const MAX_FILE_SIZE = 1 << 20
/** Whole-bundle cap: 8 MiB. */
const MAX_TOTAL_SIZE = 8 << 20
/** Maximum files per bundle. */
const MAX_FILE_COUNT = 64
/** Maximum directory nesting below the bundle root. */
const MAX_RECURSION_DEPTH = 4
/** Per-request timeout. */
const HTTP_TIMEOUT_MS = 30_000

const GITHUB_API_BASE = 'https://api.github.com'
const USER_AGENT = 'dsh-skill-remote'
const ACCEPT = 'application/vnd.github+json'

/** One GitHub Contents API entry. */
export interface ContentEntry {
  name: string
  path: string
  type: string
  size: number
  download_url: string | null
  content?: string
  encoding?: string
}

/** Mutable download counters advanced by {@link walkAndDownload}. */
export interface DownloadProgress {
  fileCount: number
  totalBytes: number
}

function requestSignal(signal: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(HTTP_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/**
 * List a repository directory through the GitHub Contents API.
 *
 * @param source - the parsed remote source.
 * @param subpath - repository-relative directory path.
 * @param signal - caller cancellation, combined with the fixed timeout.
 * @returns the parsed entry list.
 * @throws {Error} on non-200 responses or rate limiting.
 */
export async function listContents(
  source: RemoteSkillSource,
  subpath: string,
  signal?: AbortSignal,
): Promise<ContentEntry[]> {
  const url = `${GITHUB_API_BASE}/repos/${source.owner}/${source.repo}/contents/${subpath}?ref=${encodeURIComponent(source.ref)}`
  const response = await fetch(url, {
    headers: { Accept: ACCEPT, 'User-Agent': USER_AGENT },
    signal: requestSignal(signal),
  })
  if (response.status === 403) {
    throw new Error(`GitHub API denied access (rate-limited?) for ${url}`)
  }
  if (response.status !== 200) {
    throw new Error(`GitHub API returned ${response.status} for ${url}`)
  }
  return parseEntries(await response.json() as unknown)
}

/**
 * Download one file, preferring the inline base64 payload over a second
 * request to `download_url`.
 *
 * @param entry - the Contents API entry for a file.
 * @param signal - caller cancellation, combined with the fixed timeout.
 * @returns the decoded bytes.
 * @throws {Error} when the file exceeds {@link MAX_FILE_SIZE} or download fails.
 */
async function fetchBlob(entry: ContentEntry, signal?: AbortSignal): Promise<Buffer> {
  if (entry.size > MAX_FILE_SIZE) {
    throw new Error(`file ${entry.path} is too large: ${entry.size} bytes (max ${MAX_FILE_SIZE})`)
  }
  if (entry.encoding === 'base64' && entry.content !== undefined && entry.content.length > 0) {
    return Buffer.from(entry.content.replace(/\n/g, ''), 'base64')
  }
  if (entry.download_url === null || entry.download_url.length === 0) {
    throw new Error(`no download_url for ${entry.path}`)
  }
  const response = await fetch(entry.download_url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: requestSignal(signal),
  })
  if (response.status !== 200) {
    throw new Error(`download failed for ${entry.path}: status ${response.status}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

/**
 * Recursively download a bundle directory into `localDir`, enforcing every
 * safety limit. `symlink` and `submodule` entries are skipped silently.
 *
 * @param source - the parsed remote source.
 * @param subpath - repository-relative directory path to walk.
 * @param localDir - local directory receiving the files.
 * @param progress - shared download counters.
 * @param depth - current nesting depth (0 at the bundle root).
 * @param signal - caller cancellation, combined with the fixed timeout.
 */
export async function walkAndDownload(
  source: RemoteSkillSource,
  subpath: string,
  localDir: string,
  progress: DownloadProgress,
  depth: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  if (depth > MAX_RECURSION_DEPTH) {
    throw new Error(`directory nesting too deep (max ${MAX_RECURSION_DEPTH})`)
  }
  const entries = await listContents(source, subpath, signal)
  for (const entry of entries) {
    signal?.throwIfAborted()
    if (progress.fileCount >= MAX_FILE_COUNT) {
      throw new Error(`file count exceeds ${MAX_FILE_COUNT}`)
    }
    // Path-escape protection: an entry name that escapes its parent cannot
    // ever be written into the install root.
    if (entry.name.includes('..') || entry.name.includes('/') || entry.name.includes('\\')) {
      throw new Error(`suspicious file name ${JSON.stringify(entry.name)}`)
    }
    if (entry.type === 'file') {
      const data = await fetchBlob(entry, signal)
      if (progress.totalBytes + data.length > MAX_TOTAL_SIZE) {
        throw new Error(`total size exceeds ${MAX_TOTAL_SIZE} bytes`)
      }
      await mkdir(localDir, { recursive: true })
      await writeFile(join(localDir, entry.name), data)
      progress.fileCount += 1
      progress.totalBytes += data.length
    } else if (entry.type === 'dir') {
      await mkdir(join(localDir, entry.name), { recursive: true })
      await walkAndDownload(source, entry.path, join(localDir, entry.name), progress, depth + 1, signal)
    }
    // symlink / submodule: skipped
  }
}

function parseEntries(data: unknown): ContentEntry[] {
  if (!Array.isArray(data)) throw new Error('GitHub API returned a non-array contents payload')
  return data.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new Error('GitHub API returned a malformed contents entry')
    const record = entry as Record<string, unknown>
    return {
      name: stringValue(record, 'name'),
      path: stringValue(record, 'path'),
      type: stringValue(record, 'type'),
      size: typeof record.size === 'number' ? record.size : 0,
      download_url: typeof record.download_url === 'string' ? record.download_url : null,
      ...typeof record.content === 'string' ? { content: record.content } : {},
      ...typeof record.encoding === 'string' ? { encoding: record.encoding } : {},
    }
  })
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}
