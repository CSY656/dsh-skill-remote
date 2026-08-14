/**
 * SKILL.md YAML frontmatter parsing for remote skills.
 *
 * Mirrors the local `dsh-skill-filesystem` semantics (same required fields,
 * same invocation-policy keys) so a skill behaves identically whether it is
 * discovered remotely or read from disk.
 *
 * @module @deepseek-ai/dsh-skill-remote
 */

import { parse as parseYaml } from 'yaml'
import { isSkillName, type SkillInvocationPolicy } from '@deepseek-ai/dsh-skill'

/** Parsed skill metadata from a SKILL.md frontmatter block. */
export interface SkillMeta {
  /** Kebab-case skill name, validated with `isSkillName`. */
  name: string
  /** Short routing description shown by discovery consumers. */
  description: string
  /** Optional extra routing guidance. */
  whenToUse?: string
  /** Resolved model and user invocation controls. */
  invocation: SkillInvocationPolicy
}

/**
 * Split a SKILL.md document into its frontmatter mapping and body.
 *
 * @param raw - complete file text.
 * @returns `{ data, body }`, or `undefined` when the document has no valid
 *   frontmatter block (missing opener, missing closer, or non-mapping YAML).
 */
export function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  const firstLine = raw.slice(0, firstLineEnd).replace(/\r$/, '')
  if (firstLine !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  let parsed: unknown
  try {
    parsed = parseYaml(raw.slice(start, closing.start))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed as Record<string, unknown>, body: raw.slice(closing.bodyStart) }
}

/**
 * Extract and validate the skill metadata a candidate needs.
 *
 * @param data - the frontmatter mapping.
 * @returns the parsed {@link SkillMeta}, or `undefined` when the required
 *   `name`/`description` fields are missing, invalid, or the invocation
 *   policy keys are malformed.
 */
export function parseSkillMeta(data: Record<string, unknown>): SkillMeta | undefined {
  const name = stringField(data, 'name')
  const description = stringField(data, 'description')
  if (name === undefined || description === undefined) return undefined
  if (!isSkillName(name)) return undefined
  let invocation: SkillInvocationPolicy
  try {
    invocation = parseInvocationPolicy(data)
  } catch {
    return undefined
  }
  return {
    name,
    description,
    ...optionalString(data, 'whenToUse'),
    invocation,
  }
}

function findClosingFrontmatter(raw: string, start: number): { start: number; bodyStart: number } | undefined {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data: Record<string, unknown>, key: string): { [K in typeof key]?: string } {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function parseInvocationPolicy(data: Record<string, unknown>): SkillInvocationPolicy {
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false,
  }
}

function frontmatterBoolean(data: Record<string, unknown>, key: string): boolean | undefined {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}
