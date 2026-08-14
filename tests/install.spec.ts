import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installSkill, validateSkillName } from '../src/install.ts'
import { parseSkillUrl } from '../src/url.ts'

const SKILL_MD_A = '---\nname: docx\ndescription: A\n---\n\n# A\n'
const SKILL_MD_B = '---\nname: docx\ndescription: B\n---\n\n# B\n'

function apiUrlFor(subpath: string): string {
  return `https://api.github.com/repos/acme/tools/contents/${subpath}?ref=main`
}

function entry(name: string, path: string, type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, path, type, size: 100, download_url: null, ...extra }
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Mock the GitHub API: SKILL.md inline base64, sub/helper.txt via download_url. */
function stubHappyFetch(version: 'A' | 'B' = 'A'): void {
  const skillText = version === 'A' ? SKILL_MD_A : SKILL_MD_B
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input)
    if (url === apiUrlFor('skills/docx')) {
      return new Response(JSON.stringify([
        entry('SKILL.md', 'skills/docx/SKILL.md', 'file', {
          content: Buffer.from(skillText).toString('base64'),
          encoding: 'base64',
        }),
        entry('sub', 'skills/docx/sub', 'dir'),
      ]), { status: 200 })
    }
    if (url === apiUrlFor('skills/docx/sub')) {
      return new Response(JSON.stringify([
        entry('helper.txt', 'skills/docx/sub/helper.txt', 'file', {
          download_url: 'https://raw.githubusercontent.com/acme/tools/main/skills/docx/sub/helper.txt',
        }),
      ]), { status: 200 })
    }
    if (url === 'https://raw.githubusercontent.com/acme/tools/main/skills/docx/sub/helper.txt') {
      return new Response('helper content', { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }))
}

let roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-skill-remote-'))
  roots.push(root)
  return root
}

beforeEach(() => { vi.unstubAllGlobals() })
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  roots = []
})

describe('validateSkillName', () => {
  it('accepts lowercase names with dashes and underscores', () => {
    expect(() => { validateSkillName('docx') }).not.toThrow()
    expect(() => { validateSkillName('my-skill_2') }).not.toThrow()
  })

  it('rejects empty, dotted, and illegal names', () => {
    expect(() => { validateSkillName('') }).toThrow('empty')
    expect(() => { validateSkillName('.hidden') }).toThrow("must not start with '.'")
    expect(() => { validateSkillName('Bad Name') }).toThrow('illegal characters')
  })
})

describe('installSkill', () => {
  it('installs a complete bundle atomically into <root>/<name>', async () => {
    stubHappyFetch()
    const root = await tempRoot()
    const report = await installSkill(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'), root)
    expect(report).toMatchObject({ skillName: 'docx', fileCount: 2 })
    expect(report.totalBytes).toBeGreaterThan(0)
    expect(report.targetDir).toBe(join(root, 'docx'))
    expect((await readFile(join(root, 'docx', 'SKILL.md'), 'utf8'))).toBe(SKILL_MD_A)
    expect((await readFile(join(root, 'docx', 'sub', 'helper.txt'), 'utf8'))).toBe('helper content')
  })

  it('rejects a bundle without a SKILL.md manifest and leaves no staging residue', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input)
      if (url === apiUrlFor('skills/docx')) {
        return new Response(JSON.stringify([
          entry('notes.md', 'skills/docx/notes.md', 'file', {
            content: Buffer.from('no manifest').toString('base64'),
            encoding: 'base64',
          }),
        ]), { status: 200 })
      }
      return new Response('{}', { status: 404 })
    }))
    const root = await tempRoot()
    await expect(installSkill(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'), root))
      .rejects.toThrow('no SKILL.md')
    expect(await readdir(root)).toEqual([])
  })

  it('cleans the staging directory when a download fails mid-way', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = urlOf(input)
      if (url === apiUrlFor('skills/docx')) {
        return new Response(JSON.stringify([
          entry('SKILL.md', 'skills/docx/SKILL.md', 'file', {
            content: Buffer.from(SKILL_MD_A).toString('base64'),
            encoding: 'base64',
          }),
          entry('sub', 'skills/docx/sub', 'dir'),
        ]), { status: 200 })
      }
      if (url === apiUrlFor('skills/docx/sub')) {
        return new Response(JSON.stringify([
          entry('helper.txt', 'skills/docx/sub/helper.txt', 'file', {
            download_url: 'https://raw.githubusercontent.com/acme/tools/main/skills/docx/sub/helper.txt',
          }),
        ]), { status: 200 })
      }
      return new Response('boom', { status: 500 })
    }))
    const root = await tempRoot()
    await expect(installSkill(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'), root))
      .rejects.toThrow('status 500')
    expect(await readdir(root)).toEqual([])
  })

  it('replaces a previous install with the new download', async () => {
    const root = await tempRoot()
    stubHappyFetch('A')
    await installSkill(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'), root)
    expect((await readFile(join(root, 'docx', 'SKILL.md'), 'utf8'))).toBe(SKILL_MD_A)
    vi.unstubAllGlobals()
    stubHappyFetch('B')
    await installSkill(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'), root)
    expect((await readFile(join(root, 'docx', 'SKILL.md'), 'utf8'))).toBe(SKILL_MD_B)
  })
})
