import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RemoteSkillProvider } from '../src/provider.ts'
import { parseSkillUrl } from '../src/url.ts'

const SKILL_MD = '---\nname: docx\ndescription: Work with docx files\n---\n\n# Instructions\n'
const RAW_URL = 'https://raw.githubusercontent.com/acme/tools/main/skills/docx/SKILL.md'

function fakeCtx(): Context {
  return { logger: { warn: vi.fn() } } as unknown as Context
}

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function stubFetch(listing: unknown, rawStatus = 200): void {
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
    const url = urlOf(input)
    if (url.startsWith('https://api.github.com/repos/acme/tools/contents/')) {
      return new Response(JSON.stringify(listing), { status: 200 })
    }
    if (url.startsWith('https://api.github.com/repos/broken/')) {
      return new Response('{}', { status: 404 })
    }
    if (url === RAW_URL) {
      return new Response(SKILL_MD, { status: rawStatus })
    }
    return new Response('{}', { status: 404 })
  }))
}

const listing = [
  {
    name: 'SKILL.md',
    path: 'skills/docx/SKILL.md',
    type: 'file',
    size: 100,
    download_url: RAW_URL,
  },
  {
    name: 'assets',
    path: 'skills/docx/assets',
    type: 'dir',
    size: 0,
    download_url: null,
  },
]

describe('RemoteSkillProvider', () => {
  beforeEach(() => { vi.unstubAllGlobals() })
  afterEach(() => { vi.unstubAllGlobals() })

  it('returns no candidates when no remote source is registered', async () => {
    const provider = new RemoteSkillProvider(fakeCtx())
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('discovers candidates from registered sources and skips directory entries', async () => {
    stubFetch(listing)
    const provider = new RemoteSkillProvider(fakeCtx())
    provider.addRemote(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'))
    const result = await provider.list({})
    expect(result).toHaveLength(1)
    const candidate = (result as { name: string }[])[0] as unknown as Record<string, unknown>
    expect(candidate.name).toBe('docx')
    expect(candidate.description).toBe('Work with docx files')
    expect(candidate.rank).toBe(900)
    expect(candidate.source).toBe('remote')
    expect(candidate.resourceBase).toEqual({ kind: 'url', url: RAW_URL })
  })

  it('isolates a failing source and keeps the healthy ones', async () => {
    stubFetch(listing)
    const ctx = fakeCtx()
    const provider = new RemoteSkillProvider(ctx)
    provider.addRemote(parseSkillUrl('https://github.com/broken/nope/tree/main/skills/x'))
    provider.addRemote(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'))
    const result = await provider.list({})
    expect(result).toHaveLength(1)
    expect((result as { name: string }[])[0]?.name).toBe('docx')
  })

  it('logs and continues when every source fails', async () => {
    stubFetch(listing)
    const ctx = fakeCtx()
    const provider = new RemoteSkillProvider(ctx)
    provider.addRemote(parseSkillUrl('https://github.com/broken/nope/tree/main/skills/x'))
    await expect(provider.list({})).resolves.toEqual([])
  })

  it('throws when the caller signal aborts before discovery', async () => {
    stubFetch(listing)
    const provider = new RemoteSkillProvider(fakeCtx())
    provider.addRemote(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'))
    const controller = new AbortController()
    controller.abort(new Error('aborted'))
    await expect(provider.list({ signal: controller.signal })).rejects.toThrow('aborted')
  })

  it('loads the full definition through get with a url resourceBase', async () => {
    stubFetch(listing)
    const provider = new RemoteSkillProvider(fakeCtx())
    provider.addRemote(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'))
    const candidates = await provider.list({}) as unknown[]
    const definition = await provider.get(candidates[0] as never, {})
    expect(definition?.name).toBe('docx')
    expect(definition?.content).toContain('# Instructions')
    expect(definition?.resourceBase).toEqual({ kind: 'url', url: RAW_URL })
    expect(definition?.provider).toBe('remote')
  })

  it('returns undefined from get when the raw fetch is not 200', async () => {
    stubFetch(listing, 404)
    const provider = new RemoteSkillProvider(fakeCtx())
    provider.addRemote(parseSkillUrl('https://github.com/acme/tools/tree/main/skills/docx'))
    const candidates = await provider.list({}) as unknown[]
    expect(candidates).toHaveLength(0)
  })
})
