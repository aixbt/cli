#!/usr/bin/env npx tsx
/**
 * Measure token counts for recipe YAML files.
 *
 * Executes each recipe against the API, counts output tokens using tiktoken
 * (cl100k_base), and optionally writes the count back into the YAML.
 *
 * Usage:
 *   pnpm measure                          # measure all *.yaml in cwd
 *   pnpm measure surge_analysis.yaml      # measure one file
 *   pnpm measure --write *.yaml           # measure and write back
 *   pnpm measure --clusterId abc123 cluster_focus.yaml  # provide required params
 *
 * Environment:
 *   AIXBT_TIKTOKEN_ENCODING  Override tokenizer encoding (default: cl100k_base)
 *   AIXBT_API_KEY            API key for recipe execution
 *   AIXBT_API_URL            API base URL override
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { getEncoding, type TiktokenEncoding } from 'js-tiktoken'
import { parseRecipe } from '../src/lib/recipe-parser.js'
import { executeRecipe } from '../src/lib/recipe-engine.js'
import { isAgentStep } from '../src/types.js'
import { RecipeValidationError } from '../src/lib/errors.js'
import type { ApiClientOptions } from '../src/lib/api-client.js'

// -- Helpers --

function writeEstimatedTokens(yamlString: string, tokens: number): string {
  const existing = /^estimatedTokens:.*$/m
  if (existing.test(yamlString)) {
    return yamlString.replace(existing, `estimatedTokens: ${tokens}`)
  }
  const versionLine = /^(version:.*$)/m
  if (versionLine.test(yamlString)) {
    return yamlString.replace(versionLine, `$1\nestimatedTokens: ${tokens}`)
  }
  const nameLine = /^(name:.*$)/m
  return yamlString.replace(nameLine, `$1\nestimatedTokens: ${tokens}`)
}

function parseArgs(argv: string[]): { files: string[]; write: boolean; params: Record<string, string> } {
  const files: string[] = []
  const params: Record<string, string> = {}
  let write = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--write') {
      write = true
    } else if (arg.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      params[arg.slice(2)] = argv[i + 1]
      i++
    } else if (!arg.startsWith('--')) {
      files.push(arg)
    }
  }

  return { files, write, params }
}

// -- Main --

async function main(): Promise<void> {
  const { files, write, params } = parseArgs(process.argv.slice(2))

  // Resolve file list
  let resolved: string[] = []
  if (files.length === 0) {
    const cwd = process.cwd()
    resolved = readdirSync(cwd)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => resolve(cwd, f))
  } else {
    for (const f of files) {
      const full = resolve(f)
      if (!existsSync(full)) {
        console.error(`File not found: ${f}`)
        continue
      }
      resolved.push(full)
    }
  }

  if (resolved.length === 0) {
    console.error('No recipe YAML files found')
    process.exit(1)
  }

  const encoding = (process.env.AIXBT_TIKTOKEN_ENCODING ?? 'cl100k_base') as TiktokenEncoding
  const enc = getEncoding(encoding)
  const clientOptions: ApiClientOptions = {}

  console.log(`Encoding: ${encoding}`)
  console.log()

  let measured = 0

  for (const file of resolved) {
    const yamlString = readFileSync(file, 'utf-8')

    let recipe
    try {
      recipe = parseRecipe(yamlString)
    } catch (err) {
      const msg = err instanceof RecipeValidationError ? err.issues[0]?.message : String(err)
      console.error(`Skipping ${file}: ${msg}`)
      continue
    }

    // Check for required params without defaults
    const missing: string[] = []
    if (recipe.params) {
      for (const [name, param] of Object.entries(recipe.params)) {
        if (param.required && param.default === undefined && !(name in params)) {
          missing.push(name)
        }
      }
    }

    if (missing.length > 0) {
      console.warn(`Skipping ${recipe.name}: required params without defaults: ${missing.join(', ')}`)
      continue
    }

    if (recipe.steps.some(isAgentStep)) {
      console.warn(`Skipping ${recipe.name}: contains agent steps`)
      continue
    }

    try {
      process.stdout.write(`Measuring ${recipe.name}...`)

      const result = await executeRecipe({
        yaml: yamlString,
        params,
        clientOptions,
        recipeSource: file,
      })

      if (result.status !== 'complete') {
        console.log(` skipped (status: ${result.status})`)
        continue
      }

      const tokens = enc.encode(JSON.stringify(result.data)).length

      if (write) {
        const updated = writeEstimatedTokens(yamlString, tokens)
        writeFileSync(file, updated, 'utf-8')
        console.log(` ${tokens} tokens (~${Math.round(tokens / 1000)}k) — written`)
      } else {
        console.log(` ${tokens} tokens (~${Math.round(tokens / 1000)}k)`)
      }

      measured++
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(` error: ${msg}`)
    }
  }

  console.log()
  console.log(`Measured ${measured} recipe${measured !== 1 ? 's' : ''}`)
  if (!write && measured > 0) {
    console.log('Run with --write to update estimatedTokens in each file')
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
