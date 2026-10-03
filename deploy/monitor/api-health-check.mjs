#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = path.dirname(fileURLToPath(import.meta.url))
const configPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(directory, 'endpoints.json')

function readPath(value, keyPath) {
  return keyPath.split('.').reduce((current, key) => current?.[key], value)
}

async function checkEndpoint(baseUrl, endpoint, defaultTimeoutMs) {
  const url = new URL(endpoint.path, baseUrl).toString()
  const expectedStatus = endpoint.expectedStatus ?? 200
  const timeoutMs = endpoint.timeoutMs ?? defaultTimeoutMs
  const startedAt = performance.now()

  try {
    const response = await fetch(url, {
      method: endpoint.method ?? 'GET',
      headers: endpoint.headers,
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.text()
    const elapsedMs = Math.round(performance.now() - startedAt)

    if (response.status !== expectedStatus) {
      return {
        name: endpoint.name,
        ok: false,
        status: response.status,
        elapsedMs,
        error: `expected HTTP ${expectedStatus}`,
      }
    }

    if (endpoint.expectedJson) {
      let json
      try {
        json = JSON.parse(body)
      } catch {
        return { name: endpoint.name, ok: false, status: response.status, elapsedMs, error: 'response is not valid JSON' }
      }

      for (const [keyPath, expectedValue] of Object.entries(endpoint.expectedJson)) {
        if (readPath(json, keyPath) !== expectedValue) {
          return {
            name: endpoint.name,
            ok: false,
            status: response.status,
            elapsedMs,
            error: `${keyPath} did not equal ${JSON.stringify(expectedValue)}`,
          }
        }
      }
    }

    return { name: endpoint.name, ok: true, status: response.status, elapsedMs }
  } catch (error) {
    return {
      name: endpoint.name,
      ok: false,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const config = JSON.parse(await readFile(configPath, 'utf8'))
const baseUrl = (process.env.API_HEALTH_BASE_URL ?? config.baseUrl ?? '').replace(/\/$/u, '')
const timeoutMs = Number(process.env.API_HEALTH_TIMEOUT_MS ?? config.timeoutMs ?? 10000)

if (!baseUrl || !Array.isArray(config.endpoints) || config.endpoints.length === 0) {
  throw new Error('监控配置必须包含 baseUrl 和至少一个 endpoints 项')
}

const results = await Promise.all(
  config.endpoints.map((endpoint) => checkEndpoint(baseUrl, endpoint, timeoutMs)),
)

for (const result of results) {
  const status = result.status ? `HTTP ${result.status}` : 'NO RESPONSE'
  const detail = result.ok ? '' : ` - ${result.error}`
  console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name} | ${status} | ${result.elapsedMs}ms${detail}`)
}

const failed = results.filter((result) => !result.ok)
console.log(`Summary: ${results.length - failed.length} passed, ${failed.length} failed`)
process.exitCode = failed.length === 0 ? 0 : 1
