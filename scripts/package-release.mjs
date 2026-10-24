#!/usr/bin/env node
// Builds the production site and packs dist/ into a zip that can be uploaded to the host and
// extracted in place (docs/deployment.md).
//
//   pnpm package:release                              builds for DEFAULT_SITE_BASE_URL
//   VITE_SITE_BASE_URL=https://example.org pnpm package:release
//
// A fork changes DEFAULT_SITE_BASE_URL, or sets the environment variable.

import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, sep } from 'node:path'
import { crc32, deflateRawSync } from 'node:zlib'

const DEFAULT_SITE_BASE_URL = 'https://massimg.com'

const root = process.cwd()
const dist = join(root, 'dist')
const siteBaseUrl = (process.env.VITE_SITE_BASE_URL?.trim() || DEFAULT_SITE_BASE_URL).replace(
  /\/+$/,
  '',
)
if (!/^https:\/\/[^/\s]+$/.test(siteBaseUrl)) {
  console.error(
    `VITE_SITE_BASE_URL must be an https:// address with no path, got "${siteBaseUrl}".`,
  )
  process.exit(1)
}

// Not uploaded: .vite is build bookkeeping the running site never reads, .DS_Store is Finder noise.
const EXCLUDED = new Set(['.vite', '.DS_Store'])

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    // Windows cannot start pnpm.cmd without a shell.
    shell: process.platform === 'win32',
    env: { ...process.env, VITE_SITE_BASE_URL: siteBaseUrl },
  })
  if (result.status !== 0) {
    console.error(`\n\`${command} ${args.join(' ')}\` failed; no zip was written.`)
    process.exit(result.status ?? 1)
  }
}

console.log(`Building for ${siteBaseUrl}\n`)
run('pnpm', ['build'])
run('pnpm', ['verify:ssg'])

// verify:ssg proves the pages agree with each other, not that they agree with the real address:
// a build whose environment variable did not reach the sitemap script would be consistent and
// still wrong.
const placeholder = readdirSync(dist)
  .filter((name) => /\.(html|xml|txt)$/.test(name))
  .filter((name) => readFileSync(join(dist, name), 'utf8').includes('.invalid'))
if (placeholder.length > 0) {
  console.error(`The placeholder address is still in: ${placeholder.join(', ')}. No zip written.`)
  process.exit(1)
}
if (!readFileSync(join(dist, 'sitemap.xml'), 'utf8').includes(`<loc>${siteBaseUrl}/`)) {
  console.error(`dist/sitemap.xml does not list ${siteBaseUrl}. No zip written.`)
  process.exit(1)
}

// A zip written by hand: the format is a list of (header, deflated bytes) followed by a directory
// of them, and writing it here avoids needing a `zip` program, which Windows lacks.
function dosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980)
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

function listEntries() {
  const entries = []
  const visit = (directory, prefix) => {
    for (const name of readdirSync(directory).sort()) {
      if (EXCLUDED.has(name)) continue
      const path = join(directory, name)
      const zipName = prefix + name
      if (statSync(path).isDirectory()) {
        entries.push({ name: `${zipName}/`, directory: true, mtime: statSync(path).mtime })
        visit(path, `${zipName}/`)
      } else {
        entries.push({ name: zipName, path, directory: false, mtime: statSync(path).mtime })
      }
    }
  }
  visit(dist, '')
  return entries
}

function buildZip(entries) {
  const parts = []
  const directory = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name.split(sep).join('/'), 'utf8')
    const raw = entry.directory ? Buffer.alloc(0) : readFileSync(entry.path)
    const deflated = entry.directory ? raw : deflateRawSync(raw, { level: 9 })
    const stored = entry.directory || deflated.length >= raw.length
    const body = stored ? raw : deflated
    const { time, date } = dosDateTime(entry.mtime)
    const crc = entry.directory ? 0 : crc32(raw)
    const method = stored ? 0 : 8

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    parts.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4) // made on Unix, so the permission bits below apply
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    // External attributes: Unix permission bits in the high half, the DOS directory flag in the low.
    central.writeUInt32LE((entry.directory ? (0o40755 << 16) | 0x10 : 0o100644 << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    directory.push(central, name)

    offset += local.length + name.length + body.length
  }

  const directorySize = directory.reduce((sum, part) => sum + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directorySize, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, ...directory, end])
}

const entries = listEntries()
const zip = buildZip(entries)

// Local time, so the file name matches the clock the person running it is looking at.
const now = new Date()
const pad = (value) => String(value).padStart(2, '0')
const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
const outDir = join(root, 'release')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, `${new URL(siteBaseUrl).hostname}-${stamp}.zip`)
writeFileSync(outFile, zip)

const files = entries.filter((entry) => !entry.directory).length
console.log(
  `\nWrote ${outFile}\n${files} files, ${(zip.length / 1e6).toFixed(1)} MB, built for ${siteBaseUrl}.`,
)
console.log('Upload it to public_html, extract it there, then run `pnpm verify:deploy`.')
