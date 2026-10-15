// Bundles the app's main process (and the Shipwatch core it imports) into dist/main.js, so the packaged app
// carries no node_modules. `--tests` bundles the *.spec.ts files into dist-test for `node --test`.

import { build } from 'esbuild'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', logLevel: 'info' }

if (process.argv.includes('--tests')) {
  const tests = readdirSync('src')
    .filter(f => f.endsWith('.spec.ts'))
    .map(f => join('src', f))
  await build({ ...common, entryPoints: tests, outdir: 'dist-test', outExtension: { '.js': '.spec.js' } })
} else {
  await build({ ...common, entryPoints: ['src/main.ts'], outfile: 'dist/main.js', external: ['electron', 'electron-updater'], minify: false })
}
