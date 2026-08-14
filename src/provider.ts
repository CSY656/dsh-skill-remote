/**
 * Remote skill provider for the `ctx.skills` registry.
 *
 * Discovers skills from registered public GitHub sources (skills.sh URLs,
 * github.com tree URLs) and loads their bodies on demand. Candidates rank
 * below every local provider so a same-named local skill always wins.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

import type { Context } from '@deepseek-ai/cordis'
import type {
  SkillCandidate,
  SkillDefinition,
  SkillInvocationPolicy,
  SkillLookupOptions,
  SkillProvider,
  SkillProviderObservation,
  SkillSource,
} from '@deepseek-ai/dsh-skill'
import { listContents, type ContentEntry } from './github.ts'
import { parseFrontmatter, parseSkillMeta } from './frontmatter.ts'
import type { RemoteSkillSource } from './url.ts'

/** Remote candidates rank below every shipped local root (100-600). */
const REMOTE_RANK = 900

/** Opaque `SkillCandidate.locator` payload for this provider. */
interface RemoteLocator {
  /** The parsed remote source owning this skill. */
  source: RemoteSkillSource
  /** Repository-relative path of the SKILL.md file. */
  entryPath: string
  /** Full raw.githubusercontent.com URL of the SKILL.md file. */
  rawUrl: string
}

interface ParsedCandidate extends SkillMeta {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
}

interface SkillMeta {
  name: string
  description: string
  whenToUse?: string
  invocation: SkillInvocationPolicy
}

/**
 * Provider that maps registered public GitHub skill sources into `ctx.skills`.
 */
export class RemoteSkillProvider implements SkillProvider {
  readonly name: string
  private readonly remotes = new Map<string, RemoteSkillSource>()

  constructor(
    private readonly ctx: Context,
    name = 'remote',
  ) {
    this.name = name
  }

  /** Register one remote source; the map key is the normalized original URL. */
  addRemote(source: RemoteSkillSource): void {
    this.remotes.set(normalizeRemoteKey(source.original), source)
  }

  /** Remove one remote source by its original URL. */
  removeRemote(url: string): void {
    this.remotes.delete(normalizeRemoteKey(url))
  }

  /** Drop every registered remote source (plugin teardown). */
  clearRemotes(): void {
    this.remotes.clear()
  }

  /** Number of registered remote sources (exposed for tests). */
  remoteCount(): number {
    return this.remotes.size
  }

  /**
   * Discover candidates from every registered source. One failing source is
   * logged and skipped; the others still contribute.
   */
  async list(options: SkillLookupOptions): Promise<SkillCandidate[] | SkillProviderObservation> {
    const candidates: SkillCandidate[] = []
    for (const source of this.remotes.values()) {
      options.signal?.throwIfAborted()
      try {
        const entries = await listContents(source, source.subpath, options.signal)
        for (const entry of sortedEntries(entries)) {
          options.signal?.throwIfAborted()
          const file = skillFileOf(source, entry)
          if (file === undefined) continue
          const candidate = await this.candidateFromFile(source, file, options.signal)
          if (candidate !== undefined) candidates.push(candidate)
        }
      } catch (error) {
        this.ctx.logger.warn(`skill-remote: source ${source.original} failed: ${errorMessage(error)}`)
      }
    }
    return candidates
  }

  /**
   * Load one candidate's SKILL.md body over the network.
   */
  async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
    options.signal?.throwIfAborted()
    const locator = candidate.locator as RemoteLocator
    const parsed = await this.fetchRemoteText(locator.rawUrl, options.signal)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'url', url: locator.rawUrl },
      content: parsed.body.trim(),
    }
  }

  private async candidateFromFile(
    source: RemoteSkillSource,
    entryPath: string,
    signal?: AbortSignal,
  ): Promise<SkillCandidate | undefined> {
    signal?.throwIfAborted()
    const rawUrl = rawUrlOf(source, entryPath)
    const parsed = await this.fetchRemoteText(rawUrl, signal)
    if (parsed === undefined) return undefined
    const locator: RemoteLocator = { source, entryPath, rawUrl }
    return {
      name: parsed.name,
      description: parsed.description,
      ...parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {},
      invocation: parsed.invocation,
      provider: this.name,
      source: REMOTE_SOURCE,
      rank: REMOTE_RANK,
      locator,
      resourceBase: { kind: 'url', url: rawUrl },
    }
  }

  private async fetchRemoteText(rawUrl: string, signal?: AbortSignal): Promise<ParsedCandidate & { body: string } | undefined> {
    let raw: string
    try {
      const response = await fetch(rawUrl, {
        headers: { 'User-Agent': 'dsh-skill-remote' },
        signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
      })
      if (response.status !== 200) return undefined
      raw = await response.text()
    } catch (error) {
      if (signal?.aborted === true) throw error
      return undefined
    }
    signal?.throwIfAborted()
    const frontmatter = parseFrontmatter(raw)
    if (frontmatter === undefined) return undefined
    const meta = parseSkillMeta(frontmatter.data)
    if (meta === undefined) return undefined
    return { ...meta, body: frontmatter.body }
  }
}

const REMOTE_SOURCE: SkillSource = 'remote'

/**
 * Map one Contents API entry to the SKILL.md file it represents:
 * directories contribute `<entry>/SKILL.md`, flat `.md` files contribute
 * themselves. Everything else is skipped.
 */
function skillFileOf(source: RemoteSkillSource, entry: ContentEntry): string | undefined {
  if (entry.type === 'dir') return `${source.subpath}/${entry.name}/SKILL.md`
  if (entry.type === 'file' && entry.name.endsWith('.md')) return entry.path
  return undefined
}

function sortedEntries(entries: ContentEntry[]): ContentEntry[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name))
}

function rawUrlOf(source: RemoteSkillSource, entryPath: string): string {
  return `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${source.ref}/${entryPath}`
}

function normalizeRemoteKey(url: string): string {
  return url.trim().toLowerCase()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
