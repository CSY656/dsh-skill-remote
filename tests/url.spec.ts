import { describe, expect, it } from 'vitest'
import { parseSkillUrl } from '../src/url.ts'

describe('parseSkillUrl', () => {
  it('parses a skills.sh URL into the skills/ subpath with ref main', () => {
    const source = parseSkillUrl('https://www.skills.sh/anthropics/skills/docx')
    expect(source).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
      subpath: 'skills/docx',
      name: 'docx',
      original: 'https://www.skills.sh/anthropics/skills/docx',
    })
  })

  it('accepts the bare skills.sh host and nested skill paths', () => {
    const source = parseSkillUrl('https://skills.sh/acme/toolbox/nested/foo')
    expect(source).toMatchObject({
      owner: 'acme',
      repo: 'toolbox',
      ref: 'main',
      subpath: 'skills/nested/foo',
      name: 'foo',
    })
  })

  it('parses a github.com tree URL with an explicit ref', () => {
    const source = parseSkillUrl('https://github.com/anthropics/skills/tree/develop/skills/pdf')
    expect(source).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'develop',
      subpath: 'skills/pdf',
      name: 'pdf',
    })
  })

  it('parses a raw.githubusercontent.com URL and drops the file name', () => {
    const source = parseSkillUrl('https://raw.githubusercontent.com/anthropics/skills/main/skills/docx/SKILL.md')
    expect(source).toMatchObject({
      owner: 'anthropics',
      repo: 'skills',
      ref: 'main',
      subpath: 'skills/docx',
      name: 'docx',
    })
  })

  it('rejects non-http(s) URLs', () => {
    expect(() => parseSkillUrl('file:///etc/passwd')).toThrow('must use http(s)')
  })

  it('rejects malformed github.com URLs without the tree segment', () => {
    expect(() => parseSkillUrl('https://github.com/anthropics/skills')).toThrow('must be /<owner>/<repo>/tree')
  })

  it('rejects unsupported hosts', () => {
    expect(() => parseSkillUrl('https://gitlab.com/a/b/tree/main/x')).toThrow('unsupported skill URL host')
  })

  it('rejects empty and unparseable input', () => {
    expect(() => parseSkillUrl('')).toThrow('invalid skill URL')
    expect(() => parseSkillUrl('not a url')).toThrow('invalid skill URL')
  })
})
