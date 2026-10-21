import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { gzipSync } from "node:zlib"

// Sizes of the built app's highlighting assets: `bun bundle.ts <dist>`. Shiki ships its oniguruma engine and one
// chunk per grammar or theme, loaded on demand; Highlights ships one chunk with its WebAssembly inlined.
const dist = process.argv[2] ?? "dist"

const assets = path.join(dist, "_assets")

const files = await readdir(assets, { recursive: true })

const all = await Promise.all(
  files
    .filter((file) => /\.(js|mjs|wasm)$/.test(file))
    .map(async (file) => {
      const bytes = await readFile(path.join(assets, file))

      return {
        file,
        bytes: bytes.length,
        gzip: gzipSync(bytes).length,
        // The start of Highlights' inlined WebAssembly module, as base64.
        highlights: bytes.includes("AGFzbQEAAAABWw5gAX8Bf2AAAGACf38Bf2ABfw"),
      }
    }),
)

const total = (items: typeof all) => ({
  files: items.length,
  kb: Math.round(items.reduce((sum, item) => sum + item.bytes, 0) / 1024),
  gzipKB: Math.round(items.reduce((sum, item) => sum + item.gzip, 0) / 1024),
})

const highlights = all.filter((item) => item.highlights)

const onig = all.filter((item) => /^wasm-|onig/i.test(path.basename(item.file)) && !item.highlights)

const workers = all.filter((item) => /worker/i.test(item.file))

console.log(
  JSON.stringify(
    {
      all: total(all),
      highlights: {
        ...total(highlights),
        files: highlights.map((item) => `${item.file} ${Math.round(item.bytes / 1024)} KB`),
      },
      oniguruma: { ...total(onig), files: onig.map((item) => `${item.file} ${Math.round(item.bytes / 1024)} KB`) },
      workers: workers.map(
        (item) => `${item.file} ${Math.round(item.bytes / 1024)} KB (${Math.round(item.gzip / 1024)} KB gz)`,
      ),
      largest: all
        .toSorted((a, b) => b.bytes - a.bytes)
        .slice(0, 25)
        .map((item) => `${item.file} ${Math.round(item.bytes / 1024)} KB (${Math.round(item.gzip / 1024)} KB gz)`),
    },
    null,
    2,
  ),
)
