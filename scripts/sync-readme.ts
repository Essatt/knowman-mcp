// Rewrites the generated CLI reference block in README.md. Run: bun run docs:sync
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { syncReadme } from '../src/readme-blocks'

const path = resolve(import.meta.dir, '..', 'README.md')
writeFileSync(path, syncReadme(readFileSync(path, 'utf8')))
console.log(`updated ${path}`)
