/**
 * Remote skill source URL parsing.
 *
 * Turns the three supported public skill URL shapes into a structured
 * `RemoteSkillSource` description used by the GitHub client and installer:
 *
 * - `https://www.skills.sh/<owner>/<repo>/<skill-name>` — maps to the repo's
 *   `skills/` directory, default branch `main`.
 * - `https://github.com/<owner>/<repo>/tree/<ref>/<subpath>` — a directory
 *   tree URL with an explicit ref.
 * - `https://raw.githubusercontent.com/<owner>/<repo>/<ref>/<subpath>/SKILL.md`
 *   — a raw file URL; the trailing file name is dropped.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

/** A parsed remote skill source (the GitHub location of one skill bundle). */
export interface RemoteSkillSource {
  /** Repository owner (user or organization). */
  owner: string
  /** Repository name. */
  repo: string
  /** Branch or tag; defaults to `main` for skills.sh URLs. */
  ref: string
  /** Repository-relative directory path, without leading or trailing `/`. */
  subpath: string
  /** The last path segment of `subpath`; the default skill name. */
  name: string
  /** The user's original URL, kept verbatim for error messages. */
  original: string
}

function splitPath(url: URL): string[] {
  return url.pathname.split('/').filter(segment => segment.length > 0)
}

function requireSegment(segments: string[], index: number, context: string): string {
  const segment = segments[index]
  if (segment === undefined || segment.length === 0) {
    throw new Error(`skill URL is malformed: ${context}`)
  }
  return segment
}

/**
 * Parse a user-supplied skill URL into a {@link RemoteSkillSource}.
 *
 * @param raw - the URL string (skills.sh, github.com tree, or raw.githubusercontent.com).
 * @returns the parsed source description.
 * @throws {Error} when the URL is unsupported, not http(s), or malformed.
 */
export function parseSkillUrl(raw: string): RemoteSkillSource {
  const trimmed = raw.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error(`invalid skill URL: ${JSON.stringify(trimmed)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`skill URL must use http(s), got "${url.protocol}"`)
  }
  const host = url.hostname.toLowerCase()
  const parts = splitPath(url)

  if (host === 'skills.sh' || host === 'www.skills.sh') {
    if (parts.length < 3) {
      throw new Error('skills.sh URL must be /<owner>/<repo>/<skill-name>')
    }
    const owner = requireSegment(parts, 0, 'missing owner')
    const repo = requireSegment(parts, 1, 'missing repo')
    const rest = parts.slice(2)
    return {
      owner,
      repo,
      ref: 'main',
      subpath: `skills/${rest.join('/')}`,
      name: rest[rest.length - 1] ?? '',
      original: trimmed,
    }
  }

  if (host === 'github.com') {
    if (parts.length < 5 || parts[2] !== 'tree') {
      throw new Error('github.com URL must be /<owner>/<repo>/tree/<ref>/<subpath>')
    }
    const owner = requireSegment(parts, 0, 'missing owner')
    const repo = requireSegment(parts, 1, 'missing repo')
    const ref = requireSegment(parts, 3, 'missing ref')
    const sub = parts.slice(4).join('/')
    return {
      owner,
      repo,
      ref,
      subpath: sub,
      name: parts[parts.length - 1] ?? '',
      original: trimmed,
    }
  }

  if (host === 'raw.githubusercontent.com') {
    if (parts.length < 4) {
      throw new Error('raw.githubusercontent.com URL is too short (expected /<owner>/<repo>/<ref>/<subpath>[/<file>])')
    }
    const owner = requireSegment(parts, 0, 'missing owner')
    const repo = requireSegment(parts, 1, 'missing repo')
    const ref = requireSegment(parts, 2, 'missing ref')
    let subParts = parts.slice(3)
    // Drop the trailing file name when present (e.g. .../foo/SKILL.md).
    const last = subParts[subParts.length - 1] ?? ''
    if (last.includes('.')) subParts = subParts.slice(0, -1)
    if (subParts.length === 0) {
      throw new Error('raw URL is missing the skill subpath')
    }
    return {
      owner,
      repo,
      ref,
      subpath: subParts.join('/'),
      name: subParts[subParts.length - 1] ?? '',
      original: trimmed,
    }
  }

  throw new Error(`unsupported skill URL host "${host}" (use skills.sh, github.com, or raw.githubusercontent.com)`)
}
