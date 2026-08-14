import { defineConfig } from 'tsdown'

// Self-contained build for git-host installs: pnpm runs `prepare` after
// `dsh plugin add github:...` and this config transpiles src/ without
// monorepo project references or type-checking context.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'lib',
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/],
  },
})
