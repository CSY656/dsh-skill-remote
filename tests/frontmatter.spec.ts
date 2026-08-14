import { describe, expect, it } from 'vitest'
import { parseFrontmatter, parseSkillMeta } from '../src/frontmatter.ts'

describe('parseFrontmatter', () => {
  it('splits a valid frontmatter block from the body', () => {
    const result = parseFrontmatter('---\nname: docx\ndescription: Work with docx files\n---\n\n# Body\n')
    expect(result).toBeDefined()
    expect(result?.data).toEqual({ name: 'docx', description: 'Work with docx files' })
    expect(result?.body).toContain('# Body')
  })

  it('tolerates CRLF line endings', () => {
    const result = parseFrontmatter('---\r\nname: docx\r\ndescription: d\r\n---\r\nbody\r\n')
    expect(result?.data).toEqual({ name: 'docx', description: 'd' })
  })

  it('returns undefined for missing opener', () => {
    expect(parseFrontmatter('name: docx\n---\n')).toBeUndefined()
  })

  it('returns undefined for an unclosed block', () => {
    expect(parseFrontmatter('---\nname: docx\n')).toBeUndefined()
  })

  it('returns undefined for a non-mapping frontmatter', () => {
    expect(parseFrontmatter('---\n- just\n- a list\n---\nbody\n')).toBeUndefined()
  })

  it('returns undefined for invalid YAML', () => {
    expect(parseFrontmatter('---\nname: [unclosed\n---\nbody\n')).toBeUndefined()
  })
})

describe('parseSkillMeta', () => {
  it('extracts name, description, whenToUse and default invocation', () => {
    const meta = parseSkillMeta({ name: 'docx', description: 'Work with docx', whenToUse: 'for word files' })
    expect(meta).toEqual({
      name: 'docx',
      description: 'Work with docx',
      whenToUse: 'for word files',
      invocation: { modelInvocable: true, userInvocable: true },
    })
  })

  it('parses invocation policy keys', () => {
    const meta = parseSkillMeta({ name: 'secret', description: 'd', 'disable-model-invocation': true, 'user-invocable': false })
    expect(meta?.invocation).toEqual({ modelInvocable: false, userInvocable: false })
  })

  it('returns undefined without a name or description', () => {
    expect(parseSkillMeta({ description: 'd' })).toBeUndefined()
    expect(parseSkillMeta({ name: 'docx' })).toBeUndefined()
  })

  it('rejects invalid skill names', () => {
    expect(parseSkillMeta({ name: 'Bad Name!', description: 'd' })).toBeUndefined()
    expect(parseSkillMeta({ name: 'UPPER', description: 'd' })).toBeUndefined()
  })

  it('returns undefined for malformed invocation policy values', () => {
    expect(parseSkillMeta({ name: 'docx', description: 'd', 'user-invocable': 'maybe' })).toBeUndefined()
  })
})
