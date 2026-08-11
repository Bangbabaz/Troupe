/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')

function loadTypeScript(relativePath) {
  const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const loaded = { exports: {} }
  new Function('exports', 'require', 'module', compiled)(loaded.exports, require, loaded)
  return loaded.exports
}

const { isJsonContentType, isMcpRequestAuthorized, isMcpRequestOriginAllowed } = loadTypeScript(
  'src/main/mcp-http-security.ts'
)

const token = 'a'.repeat(64)

assert.equal(
  isMcpRequestAuthorized({}, new URL(`http://127.0.0.1:9876/mcp?auth=${token}`), token),
  true
)
assert.equal(
  isMcpRequestAuthorized(
    { authorization: `Bearer ${token}` },
    new URL('http://127.0.0.1:9876/mcp'),
    token
  ),
  true
)
assert.equal(isMcpRequestAuthorized({}, new URL('http://127.0.0.1:9876/mcp'), token), false)
assert.equal(
  isMcpRequestAuthorized(
    { authorization: 'Bearer wrong' },
    new URL(`http://127.0.0.1:9876/mcp?auth=${token}`),
    token
  ),
  false
)

assert.equal(isMcpRequestOriginAllowed({}), true)
assert.equal(isMcpRequestOriginAllowed({ origin: 'https://example.test' }), false)
assert.equal(isMcpRequestOriginAllowed({ origin: 'null' }), false)

assert.equal(isJsonContentType({ 'content-type': 'application/json' }), true)
assert.equal(isJsonContentType({ 'content-type': 'application/json; charset=utf-8' }), true)
assert.equal(isJsonContentType({ 'content-type': 'text/plain' }), false)
assert.equal(isJsonContentType({}), false)

console.log('MCP HTTP security tests passed')
