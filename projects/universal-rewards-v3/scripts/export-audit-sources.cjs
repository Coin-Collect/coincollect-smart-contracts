'use strict'

const assert = require('node:assert/strict')
const { execFileSync, spawnSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const pristineSourceCommit = '31ff0617b60aaafcbe155f4a266eab9e62455c8a'
const overlays = [
  'contracts/RewardRoutePlanner.sol',
  'contracts/RewardSwapAdapter.sol',
  'contracts/UniversalRewards.sol',
  'contracts/v36/TreasuryVaultV36.sol',
]

function readRelease(directory, expectedManifest) {
  const manifest = fs.readFileSync(path.join(directory, 'manifest.json'))
  assert.deepEqual(manifest, fs.readFileSync(path.join(__dirname, '..', expectedManifest)))
  const input = fs.readFileSync(path.join(directory, 'standard-input.json'))
  assert.equal(createHash('sha256').update(input).digest('hex'), JSON.parse(manifest).standardInputSha256)
  return JSON.parse(input)
}

function exportAuditSources(frozen, hardened, output) {
  const previous = readRelease(frozen, 'release-manifest.json')
  const current = readRelease(hardened, 'release-manifest-v361.json')
  const sourceDirectory = path.join(output, 'compiled-sources')
  for (const [name, { content }] of Object.entries(current.sources)) {
    assert.ok(/^(?:contracts|@openzeppelin)\/(?:[\w@.-]+\/)*[\w.-]+\.sol$/.test(name))
    assert.ok(name.split('/').every((part) => part !== '.' && part !== '..'))
    assert.equal(typeof content, 'string')
    const target = path.join(sourceDirectory, name)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, content)
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'coincollect-compiler-diff-'))
  try {
    const oldFile = path.join(temporary, 'before')
    const newFile = path.join(temporary, 'after')
    const unified = (before, after, oldLabel, newLabel) => {
      if (before === after) return ''
      fs.writeFileSync(oldFile, before ?? '')
      fs.writeFileSync(newFile, after ?? '')
      const result = spawnSync('diff', ['-u', '-L', oldLabel, '-L', newLabel, oldFile, newFile], {
        encoding: 'utf8',
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      })
      assert.equal(result.status, 1, result.error?.message ?? result.stderr)
      return result.stdout
    }
    const pretty = (value) => JSON.stringify(value, null, 2) + '\n'
    const diff = ['# V3.5.4 compiler input to V3.6.1 compiler input\n']
    diff.push(unified(pretty(previous.settings), pretty(current.settings),
      'v354/compiler-settings.json', 'v361/compiler-settings.json'))
    const names = new Set([...Object.keys(previous.sources), ...Object.keys(current.sources)])
    for (const name of [...names].sort()) {
      const oldSource = previous.sources[name]?.content
      const newSource = current.sources[name]?.content
      diff.push(unified(oldSource, newSource, oldSource === undefined ? '/dev/null' : 'v354/' + name,
        newSource === undefined ? '/dev/null' : 'v361/' + name))
    }
    diff.push('\n# V3.6.1 compiler overlays compared with pristine tracked sources\n')
    for (const name of overlays) {
      const source = execFileSync('git', ['show', pristineSourceCommit + ':projects/universal-rewards-v3/' + name], {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
      })
      assert.notEqual(source, current.sources[name].content, 'Missing expected compiler overlay')
      diff.push(unified(source, current.sources[name].content, 'tracked/' + name, 'compiled/' + name))
    }
    fs.writeFileSync(path.join(output, 'compiler-input.diff'), diff.join(''))
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true })
  }
}

const [frozen, hardened, output] = process.argv.slice(2)
assert.ok(frozen && hardened && output, 'Usage: node scripts/export-audit-sources.cjs <v354 release> <v361 release> <output>')
exportAuditSources(frozen, hardened, output)
