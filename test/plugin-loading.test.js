'use strict'

const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const { cpSync, mkdtempSync, rmSync } = require('node:fs')
const { test } = require('node:test')
const path = require('node:path')

test('osls 4 loads the plugin and validates its event schema', (context) => {
  const fixtureDirectory = mkdtempSync(path.join(__dirname, '.tmp-osls-plugin-loading-'))
  context.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }))

  cpSync(path.join(__dirname, 'fixtures', 'plugin-loading'), fixtureDirectory, {
    recursive: true
  })
  cpSync(path.join(__dirname, '..', 'dist'), path.join(fixtureDirectory, 'plugin'), {
    recursive: true
  })

  const oslsBinary = require.resolve('osls/bin/serverless.js')
  const output = execFileSync(process.execPath, [oslsBinary, 'print'], {
    cwd: fixtureDirectory,
    encoding: 'utf8',
    env: {
      ...process.env,
      AWS_DEFAULT_REGION: 'us-east-1',
      SLS_SCHEMA_CACHE_BASE_DIR: fixtureDirectory
    }
  })

  assert.match(output, /preExistingCloudFront:/)
  assert.match(output, /distributionId: EXAMPLE/)
})
