import { timingSafeEqual } from 'crypto'
import type { IncomingHttpHeaders } from 'http'

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function tokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  )
}

export function isMcpRequestAuthorized(
  headers: IncomingHttpHeaders,
  url: URL,
  expectedToken: string
): boolean {
  const authorization = firstHeaderValue(headers.authorization)
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]
  return tokenEquals(bearer || url.searchParams.get('auth') || undefined, expectedToken)
}

export function isMcpRequestOriginAllowed(headers: IncomingHttpHeaders): boolean {
  return firstHeaderValue(headers.origin) === undefined
}

export function isJsonContentType(headers: IncomingHttpHeaders): boolean {
  const contentType = firstHeaderValue(headers['content-type'])
  return contentType?.split(';', 1)[0].trim().toLowerCase() === 'application/json'
}
