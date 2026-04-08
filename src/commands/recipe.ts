import type { Command } from 'commander'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { globSync } from 'tinyglobby'
import { parse as parseYaml } from 'yaml'
import { encode as encodeToon } from '@toon-format/toon'
import type { Recipe, RecipeAwaitingAgent, RecipeComplete } from '../types.js'
import { isAgentStep, isParallelAgentStep, hasForModifier } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipeServer, validateRecipeServer } from '../lib/recipe/server.js'
import { enrichServerResponse } from '../lib/recipe/enrichment.js'
import { CliError, ApiError } from '../lib/errors.js'
import { getProviderNames, getProvider, parseSource } from '../lib/providers/registry.js'
import type { ValidationIssue } from '../types.js'
import { readConfig, resolveFormat, getRecipesDir } from '../lib/config.js'
import { fetchRecipeList, fetchRecipeDetail, fetchRecipeFromRegistry } from '../lib/registry.js'
import type { OutputFormat } from '../lib/output.js'
import * as output from '../lib/output.js'
import chalk from 'chalk'
import type { AgentAdapter } from '../lib/agents/index.js'
import { resolveAdapter, resolveAgentTarget, invokeAgentForStep, invokeAgentForAnalysis, captureAgentAnalysis, invokeParallelAgents, AGENT_COLORS } from '../lib/agents/index.js'

const SPINNER_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

/**
 * Write step data to individual files on disk, replacing inline data with
 * `{ dataFile: path }` references. Used by codex agent which reads from files.
 */
function applyOutputDir(
  result: RecipeComplete,
  outputDir: string,
  outputFormat: 'json' | 'toon',
): RecipeComplete {
  const useToon = outputFormat === 'toon'
  const ext = useToon ? 'toon' : 'json'
  try {
    mkdirSync(outputDir, { recursive: true })
    const data: Record<string, unknown> = {}
    let fileIndex = 1
    for (const [stepId, stepData] of Object.entries(result.data)) {
      if (stepId.startsWith('_')) {
        data[stepId] = stepData
        continue
      }
      const filename = `segment-${String(fileIndex).padStart(3, '0')}.${ext}`
      const filePath = join(outputDir, filename)
      const content = useToon
        ? encodeToon(stepData)
        : JSON.stringify(stepData, null, 2)
      writeFileSync(filePath, content)
      data[stepId] = { dataFile: filePath }
      fileIndex++
    }
    return { ...result, data }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`warn: Failed to write output files to ${outputDir}: ${detail}. Falling back to inline data.`)
    return result
  }
}

async function handleParallelAgentStep(
  adapter: AgentAdapter,
  awaiting: RecipeAwaitingAgent,
  structured: boolean,
  agentAllowedTools?: string[],
): Promise<Record<string, unknown>> {
  const parallel = awaiting.parallel!
  const total = parallel.items.length
  let failedCount = 0

  if (structured) {
    const results = await invokeParallelAgents(adapter, awaiting, { allowedTools: agentAllowedTools })
    return { _results: results }
  }

  // Visual mode: show progress
  const agentColor = AGENT_COLORS[adapter.binary] ?? '#888888'
  const agentLabel = chalk.hex(agentColor)(adapter.binary.toUpperCase())
  process.stderr.write(`  ${chalk.dim('↓')}\n`)

  let fi = 0
  let completedCount = 0
  const stepTick = setInterval(() => {
    process.stderr.write(`\r${agentLabel} ${SPINNER_FRAMES[fi++ % SPINNER_FRAMES.length]} ${chalk.dim(`step: ${awaiting.step} [${completedCount}/${total}]`)}`)
  }, 80)

  try {
    const results = await invokeParallelAgents(adapter, awaiting, {
      allowedTools: agentAllowedTools,
      callbacks: {
        onItemComplete: (completed, _total, failed) => {
          completedCount = completed
          if (failed) failedCount++
        },
      },
    })

    clearInterval(stepTick)
    const failSuffix = failedCount > 0 ? ` ${chalk.dim(`${failedCount} failed`)}` : ''
    process.stderr.write(`\r${agentLabel} ${output.fmt.dim('✓')} ${chalk.dim(`step: ${awaiting.step} [${total}/${total}]`)}${failSuffix}\n`)
    return { _results: results }
  } catch (err) {
    clearInterval(stepTick)
    process.stderr.write(`\r${agentLabel} ${output.fmt.red('✗')} ${chalk.dim(`step: ${awaiting.step}`)}\n`)
    throw err
  }
}

// -- Helpers --

function reportValidationResults(
  file: string,
  issues: Array<{ path: string; message: string }>,
  outputFormat: OutputFormat,
): void {
  if (issues.length === 0) return

  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured({
      status: 'invalid',
      file,
      issueCount: issues.length,
      issues,
    }, outputFormat)
  } else {
    output.error(`${file} has ${issues.length} issue${issues.length !== 1 ? 's' : ''}:`)
    console.error()
    for (const issue of issues) {
      const location = issue.path ? `  at ${issue.path}` : ''
      console.error(`x ${issue.message}${location}`)
    }
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

function extractDynamicParams(cmd: Command): Record<string, string> {
  const params: Record<string, string> = {}
  const args = cmd.args || []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) {
      const key = arg.slice(2)
      params[key] = args[i + 1]
      i++
    }
  }
  return params
}

/** Parse a YAML string into a Recipe object for display purposes (no deep validation). */
function parseRecipeLocal(yamlString: string): Recipe {
  const raw = parseYaml(yamlString) as Record<string, unknown>
  if (!raw || typeof raw.name !== 'string' || !Array.isArray(raw.steps)) {
    throw new CliError('Invalid recipe YAML: missing name or steps', 'INVALID_RECIPE')
  }
  return raw as unknown as Recipe
}

function printValidRecipeSummaryFromServer(
  file: string,
  recipe: { name: string; version: string; stepCount: number; paramCount: number },
  outputFormat: OutputFormat,
  warnings?: ValidationIssue[],
): void {
  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured({
      status: 'valid',
      recipe: recipe.name,
      version: recipe.version,
      stepCount: recipe.stepCount,
      paramCount: recipe.paramCount,
      ...(warnings?.length ? { warnings } : {}),
    }, outputFormat)
    return
  }

  output.success(`${file} is valid`)
  output.keyValue('Recipe', recipe.name, 20)
  output.keyValue('Version', recipe.version, 20)
  output.keyValue('Steps', String(recipe.stepCount), 20)
  output.keyValue('Params', String(recipe.paramCount), 20)
}

/** Local provider action validation — checks steps against the CLI's provider registry. */
function validateProviderActionsLocal(yamlString: string): ValidationIssue[] {
  let recipe: Recipe
  try {
    recipe = parseRecipeLocal(yamlString)
  } catch {
    return []
  }

  const knownProviders = getProviderNames()
  if (knownProviders.length === 0) return []

  const issues: ValidationIssue[] = []

  for (const step of recipe.steps) {
    if (isAgentStep(step)) continue

    const rawSource = step.source ?? 'aixbt'
    const { providerName: source } = parseSource(rawSource)
    const action = step.action
    if (!action) continue

    if (!knownProviders.includes(source)) {
      issues.push({
        path: `steps.${step.id}.source`,
        message: `Unknown provider "${source}". Available providers: ${knownProviders.join(', ')}`,
      })
      continue
    }

    const provider = getProvider(source)
    const isRawPath = action.startsWith('/') || action.includes(' /')
    if (!isRawPath && !provider.actions[action]) {
      const available = Object.keys(provider.actions).join(', ')
      issues.push({
        path: `steps.${step.id}.action`,
        message: `Unknown action "${action}" for provider "${source}". Available: ${available}`,
      })
    }
  }

  return issues
}

// -- Local recipe scanning --

interface LocalRecipe {
  file: string
  recipe: Recipe
  valid: boolean
}

function scanRecipeFiles(paths: string[]): LocalRecipe[] {
  const results: LocalRecipe[] = []
  const seen = new Set<string>()

  for (const file of paths) {
    if (seen.has(file)) continue
    seen.add(file)
    try {
      const yamlContent = readFileSync(file, 'utf-8')
      const raw = parseYaml(yamlContent) as Record<string, unknown>
      if (!raw || typeof raw.name !== 'string' || !raw.steps) continue

      let valid = true
      try { parseRecipeLocal(yamlContent) } catch { valid = false }

      results.push({ file, recipe: raw as unknown as Recipe, valid })
    } catch {
      // Silently skip non-recipe files
    }
  }

  return results
}

/** Check if a filename is a YAML recipe file. */
function isYamlFile(f: string): boolean {
  return f.endsWith('.yaml') || f.endsWith('.yml')
}

function looksLikeFilePath(s: string): boolean {
  return s.includes('/') || s.endsWith('.yaml') || s.endsWith('.yml')
}

function resolveFilePaths(paths: string[]): string[] {
  const files: string[] = []
  for (const p of paths) {
    if (p.includes('*') || p.includes('?')) {
      files.push(...globSync(p).filter(isYamlFile))
    } else if (existsSync(p)) {
      files.push(p)
    }
  }
  return files
}

function scanRecipesDir(dir: string): string[] {
  if (!existsSync(dir)) return []
  return globSync('**/*.{yaml,yml}', { cwd: dir }).map(f => join(dir, f))
}

/**
 * Resolve a recipe name to a local file path by checking the user recipes dir.
 * Returns the file path if found, undefined otherwise.
 */
function resolveUserRecipe(name: string): string | undefined {
  const recipesDir = getRecipesDir()
  if (!existsSync(recipesDir)) return undefined

  // Try exact match, then with .yaml/.yml extension
  const candidates = [
    join(recipesDir, name),
    join(recipesDir, `${name}.yaml`),
    join(recipesDir, `${name}.yml`),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  // Search subdirectories
  const matches = globSync(`**/${name}.{yaml,yml}`, { cwd: recipesDir })
  if (matches.length > 0) return join(recipesDir, matches[0])

  return undefined
}

// -- Command registration --

export function registerRecipeCommand(program: Command): void {
  const recipe = program.command('recipe').description('Build and run analysis pipelines')

  recipe.addHelpText('after', () => {
    return [
      '',
      `  Recipes are declarative YAML pipelines that chain API calls, iterate`,
      `  over results, sample and transform data, and yield back to you for`,
      `  inference. Clone from the registry, customize, or build your own.`,
      '',
      `  ${output.fmt.boldWhite('Quick start')}`,
      `  ${output.fmt.dim('Browse registry')}    aixbt recipe list`,
      `  ${output.fmt.dim('Recipe details')}    aixbt recipe info <name>`,
      `  ${output.fmt.dim('Run a recipe')}      aixbt recipe run <name> -f toon`,
      '',
      `  ${output.fmt.boldWhite('Docs')}`,
      `  ${output.fmt.dim('Recipe spec')}       ${output.fmt.link('https://docs.aixbt.tech/builders/recipes/recipe-specification.mdx')}`,
      `  ${output.fmt.dim('Building blocks')}   ${output.fmt.link('https://docs.aixbt.tech/builders/recipes/recipe-building-blocks.mdx')}`,
      `  ${output.fmt.dim('Guide')}             ${output.fmt.link('https://docs.aixbt.tech/builders/recipes.mdx')}`,
      '',
      `  ${output.fmt.boldWhite('Notes')}`,
      `  Recipes always return full data. Use ${output.fmt.dim('transform:')} on steps to control`,
      `  output size. ${output.fmt.dim('-v')} has no effect on recipe output.`,
      `  Use ${output.fmt.dim('-f toon')} for compact structured output (~40% smaller than json).`,
      '',
      `  ${output.fmt.boldWhite('Agent integration')}`,
      `  Use --agent to spawn an isolated inference session for recipe steps.`,
      `  This calls your locally installed Claude Code or Codex CLI — the`,
      `  agent works in a clean context with only the recipe data, freeing`,
      `  the caller to multitask and allowing use of high-thinking models.`,
      '',
      `  ${output.fmt.dim('Available agents:')}  claude, codex`,
      `  ${output.fmt.dim('Example:')}           aixbt recipe run daily_digest --agent claude`,
      `  ${output.fmt.dim('Env var:')}           AIXBT_AGENT=claude`,
      '',
    ].join('\n')
  })

  recipe
    .command('list [paths...]')
    .description('List recipes from the registry, user recipes dir, and/or local files')
    .action(async (paths: string[], _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)
      const hasExplicitPaths = paths && paths.length > 0

      // 1. Registry
      const registryRecipes = await output.withSpinner(
        'Fetching recipes...',
        outputFormat,
        () => fetchRecipeList({ apiUrl: globalOpts.apiUrl as string | undefined }),
        'Failed to fetch recipes',
        { silent: true },
      )

      // 2. User recipes dir (~/.aixbt/recipes/**)
      const recipesDir = getRecipesDir()
      const userRecipes = scanRecipeFiles(scanRecipesDir(recipesDir))

      // 3. Explicit paths from arguments
      const explicitRecipes = hasExplicitPaths
        ? scanRecipeFiles(resolveFilePaths(paths))
        : []

      const hasLocal = userRecipes.length > 0 || explicitRecipes.length > 0

      // -- Structured output --
      if (output.isStructuredFormat(outputFormat)) {
        const items = [
          ...registryRecipes.map(r => ({ ...r, source: 'registry' as const })),
          ...userRecipes.map(({ file, recipe, valid }) => ({
            name: recipe.name,
            version: recipe.version,
            description: recipe.description,
            estimatedTokens: recipe.estimatedTokens ?? null,
            stepCount: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
            paramCount: recipe.params ? Object.keys(recipe.params).length : 0,
            source: 'user' as const,
            valid,
            file,
          })),
          ...explicitRecipes.map(({ file, recipe, valid }) => ({
            name: recipe.name,
            version: recipe.version,
            description: recipe.description,
            estimatedTokens: recipe.estimatedTokens ?? null,
            stepCount: Array.isArray(recipe.steps) ? recipe.steps.length : 0,
            paramCount: recipe.params ? Object.keys(recipe.params).length : 0,
            source: 'local' as const,
            valid,
            file,
          })),
        ]
        output.outputStructured(items, outputFormat)
        return
      }

      // -- Human output --
      if (registryRecipes.length === 0 && !hasLocal) {
        output.dim('No recipes found.')
        return
      }

      // Helper to print a wrapped description (respects newlines for bullets)
      const printDescription = (desc: string, indent = 2) => {
        const pad = ' '.repeat(indent)
        const width = output.getTerminalWidth() - indent
        for (const paragraph of desc.trimEnd().split('\n')) {
          if (paragraph === '') continue
          const lines = width > 20 ? output.wrapText(paragraph, width) : [paragraph]
          for (const line of lines) console.log(`${pad}${line}`)
        }
      }

      // Helper to print a local recipe entry
      const printLocalRecipe = ({ file, recipe, valid }: LocalRecipe) => {
        console.log()
        console.log(`  ${output.fmt.brandBold(recipe.name)}  ${output.fmt.dim(`v${recipe.version}`)}  ${output.fmt.dim(file)}`)
        printDescription(recipe.description)

        const meta: string[] = []
        if (recipe.estimatedTokens) {
          meta.push(`~${Math.round(recipe.estimatedTokens / 1000)}k tokens`)
        }
        const paramCount = recipe.params ? Object.keys(recipe.params).length : 0
        if (paramCount > 0) {
          meta.push(`${paramCount} param${paramCount !== 1 ? 's' : ''}`)
        }
        const stepCount = Array.isArray(recipe.steps) ? recipe.steps.length : 0
        meta.push(`${stepCount} steps`)
        const invalidTag = valid ? '' : `  ${output.fmt.tag(' INVALID ', '#e05b73')}`
        console.log(`  ${output.fmt.dim(meta.join(' \u00b7 '))}${invalidTag}`)
      }

      // Registry section
      if (registryRecipes.length > 0) {
        console.log()
        console.log(`  ${output.fmt.boldWhite('Official AIXBT Registry')}`)
      }

      for (const r of registryRecipes) {
        console.log()
        console.log(`  ${output.fmt.brandBold(r.name)}  ${output.fmt.dim(`v${r.version}`)}`)
        printDescription(r.description)

        const meta: string[] = []
        if (r.estimatedTokens) {
          meta.push(`~${Math.round(r.estimatedTokens / 1000)}k tokens`)
        }
        if (r.paramCount > 0) {
          meta.push(`${r.paramCount} param${r.paramCount !== 1 ? 's' : ''}`)
        }
        if (meta.length > 0) {
          console.log(`  ${output.fmt.dim(meta.join(' \u00b7 '))}`)
        }
      }

      // User recipes section
      if (userRecipes.length > 0) {
        console.log()
        console.log(`  ${output.fmt.boldWhite('My Recipes')}  ${output.fmt.dim(recipesDir)}`)
        for (const entry of userRecipes) printLocalRecipe(entry)
      }

      // Explicit files section
      if (explicitRecipes.length > 0) {
        console.log()
        console.log(`  ${output.fmt.boldWhite('Files')}`)
        for (const entry of explicitRecipes) printLocalRecipe(entry)
      }

      // Footer
      console.log()
      const counts: string[] = [`${registryRecipes.length} official`]
      if (userRecipes.length > 0) counts.push(`${userRecipes.length} user`)
      if (explicitRecipes.length > 0) counts.push(`${explicitRecipes.length} files`)
      output.dim(counts.join(' · '))

      output.hint('Run aixbt recipe info <name> for details')
      const invalidCount = [...userRecipes, ...explicitRecipes].filter(r => !r.valid).length
      if (invalidCount > 0) {
        console.log(output.fmt.red('Run aixbt recipe validate <file> to see issues'))
      }
    })

  recipe
    .command('info <name>')
    .description('Show recipe details (registry name or local file path)')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      let yaml: string
      let updatedAt: string | undefined
      let resolvedSource: 'registry' | string // 'registry' or file path

      const isFilePath = looksLikeFilePath(name)

      if (isFilePath || existsSync(name)) {
        if (!existsSync(name)) {
          throw new CliError(`File not found: ${name}`, 'FILE_NOT_FOUND')
        }
        yaml = readFileSync(name, 'utf-8')
        resolvedSource = name
      } else {
        // Registry takes precedence over local — prevents name shadowing
        let fromRegistry = false
        try {
          const detail = await fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined })
          yaml = detail.yaml
          updatedAt = detail.updatedAt
          resolvedSource = 'registry'
          fromRegistry = true
        } catch (err) {
          const isNotFound = err instanceof CliError && err.code === 'RECIPE_NOT_FOUND'
          if (!isNotFound) {
            console.error(`warning: could not reach recipe registry: ${err instanceof Error ? err.message : String(err)}`)
          }
          const userFile = resolveUserRecipe(name)
          if (userFile) {
            yaml = readFileSync(userFile, 'utf-8')
            resolvedSource = userFile
          } else {
            throw new CliError(`Recipe "${name}" not found in registry or ${getRecipesDir()}`, 'RECIPE_NOT_FOUND')
          }
        }

        // Warn if local shadows registry
        if (fromRegistry) {
          const userFile = resolveUserRecipe(name)
          if (userFile) {
            const localYaml = readFileSync(userFile, 'utf-8')
            try {
              const localParsed = parseYaml(localYaml) as Record<string, unknown>
              if (localParsed && localParsed.name === name) {
                console.error(`warning: local recipe at ${userFile} shadows this official recipe (official takes precedence)`)
              }
            } catch { /* ignore parse errors */ }
          }
        }
      }

      const parsed = parseRecipeLocal(yaml)

      const steps = parsed.steps.map((step) => {
        if (isParallelAgentStep(step)) {
          return { id: step.id, type: 'agent' as const, for: step['for'], instructions: step.instructions }
        }
        if (isAgentStep(step)) {
          return { id: step.id, type: 'agent' as const, instructions: step.instructions }
        }
        if (hasForModifier(step)) {
          return { id: step.id, type: 'api' as const, action: step.action, source: step.source, for: step['for'] }
        }
        return { id: step.id, type: 'api' as const, action: step.action, source: step.source }
      })

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          ...(updatedAt ? { updatedAt } : {}),
          estimatedTokens: parsed.estimatedTokens ?? null,
          params: parsed.params ?? {},
          stepCount: parsed.steps.length,
          steps,
          hasAnalysis: !!parsed.analysis?.instructions,
          yaml,
        }, outputFormat)
        return
      }

      const sourceLabel = resolvedSource === 'registry'
        ? `  ${output.fmt.brand('official')}`
        : `  ${output.fmt.dim(resolvedSource)}`
      output.label('Recipe', `${parsed.name}${sourceLabel}`)
      output.keyValue('Version', output.fmt.number(parsed.version), 20)
      output.keyValue('Description', parsed.description, 20)
      if (updatedAt) output.keyValue('Updated', updatedAt, 20)
      output.keyValue('Steps', output.fmt.number(String(parsed.steps.length)), 20)
      if (parsed.estimatedTokens) {
        output.keyValue('Est. tokens', output.fmt.number(`~${Math.round(parsed.estimatedTokens / 1000)}k`), 20)
      }

      if (parsed.params && Object.keys(parsed.params).length > 0) {
        console.log()
        output.info('Parameters:')
        for (const [key, param] of Object.entries(parsed.params)) {
          const parts: string[] = []
          if (param.description) parts.push(param.description)
          if (param.required) parts.push(output.fmt.red('(required)'))
          if (param.default !== undefined) parts.push(output.fmt.dim(`[default: ${param.default}]`))
          output.keyValue(`--${key}`, parts.join(' '), 20, { keyStyle: output.fmt.brand })
        }
      }

      console.log()
      output.info('Steps:')
      for (const step of parsed.steps) {
        if (isParallelAgentStep(step)) {
          const ctxLabel = step.context.length > 0 ? ` ${output.fmt.dim(`[${step.context.join(', ')}]`)}` : ''
          output.keyValue(step.id, `${output.fmt.cyan('agent')} ${output.fmt.dim('for:')} ${output.fmt.dim(step['for'])}${ctxLabel}\n${output.fmt.dim(step.instructions.trim())}`, 20)
        } else if (isAgentStep(step)) {
          output.keyValue(step.id, `${output.fmt.cyan('agent')} ${output.fmt.dim(step.instructions.trim())}`, 20)
        } else if (hasForModifier(step)) {
          const label = step.source ? `${step.action} (${step.source})` : step.action
          output.keyValue(step.id, `${output.fmt.cyan('api')} ${output.fmt.dim('for:')} ${output.fmt.dim(step['for'])} ${output.fmt.green('→')} ${output.fmt.dim(label)}`, 20)
        } else {
          const label = step.source ? `${step.action} (${step.source})` : step.action
          output.keyValue(step.id, `${output.fmt.cyan('api')} ${output.fmt.dim(label)}`, 20)
        }
      }

      if (parsed.analysis?.instructions) {
        console.log()
        output.info('Analysis:')
        output.keyValue('Instructions', parsed.analysis.instructions, 20)
        if (parsed.analysis.output) output.keyValue('Output', parsed.analysis.output, 20)
      }

      // Usage example
      const paramFlags = parsed.params
        ? Object.entries(parsed.params)
            .filter(([, p]) => p.required)
            .map(([key]) => `--${key} <${key}>`)
            .join(' ')
        : ''
      const runTarget = resolvedSource === 'registry' ? parsed.name : name
      const example = `aixbt recipe run ${runTarget}${paramFlags ? ` ${paramFlags}` : ''}`
      console.log()
      output.info('Usage:')
      console.log(`  ${output.fmt.dim(example)}`)

      // Check for name clashes — local recipe has same name as an official one
      if (resolvedSource !== 'registry') {
        try {
          const registryRecipes = await fetchRecipeList({ apiUrl: globalOpts.apiUrl as string | undefined })
          const clash = registryRecipes.find(r => r.name === parsed.name)
          if (clash) {
            console.log()
            console.log(`  ${output.fmt.tag(' NAME CLASH ', '#e05b73')} An official registry recipe with the name "${parsed.name}" exists`)
            console.log(`  ${output.fmt.dim('The official version takes precedence when running by name. Use the file path to run this version.')}`)
          }
        } catch {
          // Registry unavailable — skip clash check
        }
      }
    })

  recipe
    .command('clone <name>')
    .description('Clone a recipe from the registry for local editing')
    .option('--name <newName>', 'Name for the cloned recipe (default: <name>.clone)')
    .option('--out <path>', 'Output directory (default: ~/.aixbt/recipes/)')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)
      const recipesDir = getRecipesDir()
      const cloneName = (opts.name as string) ?? `${name}.clone`
      const outDir = (opts.out as string) ?? recipesDir
      const outPath = join(outDir, `${cloneName}.yaml`)

      if (existsSync(outPath)) {
        throw new CliError(`Recipe "${cloneName}" already exists at ${outPath}`, 'FILE_EXISTS')
      }

      const detail = await output.withSpinner(
        `Fetching recipe "${name}"...`,
        outputFormat,
        () => fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined }),
        `Failed to fetch recipe "${name}"`,
      )

      // Replace the name field in the YAML to match the clone name
      const yaml = detail.yaml.replace(/^name:\s*.+$/m, `name: ${cloneName}`)

      try {
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, yaml, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown write error'
        throw new CliError(`Failed to write ${outPath}: ${msg}`, 'WRITE_FAILED')
      }

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({ status: 'cloned', name: cloneName, from: name, path: outPath }, outputFormat)
      } else {
        output.success(`Recipe cloned as "${cloneName}" → ${outPath}`)
        output.dim(`Run with: aixbt recipe run ${cloneName}`)
      }
    })

  recipe
    .command('validate [name]')
    .description('Validate a recipe YAML file without executing')
    .option('--stdin', 'Read recipe YAML from stdin')
    .action(async (name: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const { clientOpts: clientOptions } = getClientOptions(cmd)
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      if (!name && !opts.stdin) {
        throw new CliError('Provide a recipe name/path or use --stdin', 'MISSING_INPUT')
      }

      let file = name ?? 'stdin'
      let yamlString: string | undefined
      if (opts.stdin) {
        yamlString = await readStdin()
      } else if (name && existsSync(name)) {
        yamlString = readFileSync(name, 'utf-8')
      } else if (name && looksLikeFilePath(name)) {
        throw new CliError(`File not found: ${name}`, 'FILE_NOT_FOUND')
      } else if (name) {
        const userFile = resolveUserRecipe(name)
        if (userFile) {
          yamlString = readFileSync(userFile, 'utf-8')
          file = userFile
        }
        // If not found locally, fall through — will send { recipeName } to server
      }

      // Send to server: yaml if we have it, recipeName otherwise
      let result: Awaited<ReturnType<typeof validateRecipeServer>>
      try {
        result = yamlString
          ? await validateRecipeServer({ yaml: yamlString, clientOptions })
          : await validateRecipeServer({ recipeName: name!, clientOptions })
      } catch (err) {
        if (!yamlString && err instanceof ApiError && err.statusCode === 404) {
          throw new CliError(
            `Recipe "${name}" not found locally (${getRecipesDir()}) or in the registry`,
            'RECIPE_NOT_FOUND',
          )
        }
        throw err
      }

      // Server issues are authoritative errors
      const issues = result.issues ?? []
      if (issues.length > 0) {
        reportValidationResults(file, issues, outputFormat)
        process.exit(1)
      }

      // Local provider check — warnings only, never blocks
      // Only run when we have local YAML (file-based validation)
      const localWarnings = yamlString ? validateProviderActionsLocal(yamlString) : []
      if (localWarnings.length > 0 && !output.isStructuredFormat(outputFormat)) {
        output.warn(`${localWarnings.length} provider warning${localWarnings.length !== 1 ? 's' : ''} (CLI may be outdated):`)
        for (const issue of localWarnings) {
          const location = issue.path ? `  at ${issue.path}` : ''
          output.warn(`${issue.message}${location}`)
        }
      }

      if (result.recipe) {
        printValidRecipeSummaryFromServer(file, result.recipe, outputFormat, localWarnings.length > 0 ? localWarnings : undefined)
      } else {
        output.success(`${file} is valid`)
      }
    })

  recipe
    .command('run [source]')
    .description('Execute a recipe (file path, registry name, or --stdin)')
    .option('--stdin', 'Read recipe YAML from stdin')
    .option('--resume-from <step>', 'Resume from an agent step (step:<id>)')
    .option('--input <json>', 'Agent step result JSON (used with --resume-from)')
    .option('--agent <target>', 'Spawn an agent for inference steps: claude, codex')
    .option('--output-dir <path>', 'Write segment data to files instead of inline (for codex agent)')
    .option('--no-observe', 'Disable the background observer that shows data insights while the agent analyzes')
    .allowUnknownOption(true)
    .action(async (source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const { clientOpts: clientOptions } = getClientOptions(cmd)
      const globalOpts = cmd.optsWithGlobals()

      if (globalOpts.payPerUse) {
        throw new CliError(
          'Pay-per-use is not supported for recipes. Recipes make multiple API calls; use an API key instead.',
          'PAY_PER_USE_UNSUPPORTED',
        )
      }

      const verbosity = (globalOpts.verbose as number) ?? 0
      const formatFlag = globalOpts.format as string | undefined
      if (formatFlag === 'human') {
        throw new CliError(
          'Recipes output structured data for agent consumption. Use -f json or -f toon (omit -f to default to json).',
          'INVALID_FORMAT',
        )
      }
      const recipeFormat: output.StructuredFormat = formatFlag === 'toon' ? 'toon' : 'json'

      // Resolve agent target (flag > env > config)
      const config = readConfig()
      const agentTarget = resolveAgentTarget(
        opts.agent as string | undefined,
        config.agent,
      )
      const agentAllowedTools = config.agentAllowedTools

      // If an agent is specified, validate it's available before doing any work
      let adapter
      if (agentTarget) {
        adapter = resolveAdapter(agentTarget)
        if (!adapter.checkAvailable()) {
          throw new CliError(
            `Agent "${agentTarget}" (${adapter.binary}) not found on PATH. Install ${adapter.name} first.`,
            'AGENT_NOT_FOUND',
          )
        }
      }

      let yaml: string
      if (opts.stdin) {
        yaml = await readStdin()
      } else if (source && existsSync(source)) {
        yaml = readFileSync(source, 'utf-8')
      } else if (source && looksLikeFilePath(source)) {
        throw new CliError(`File not found: ${source}`, 'FILE_NOT_FOUND')
      } else if (source) {
        // Registry takes precedence over local — prevents name shadowing
        try {
          yaml = await fetchRecipeFromRegistry(source, clientOptions)
          const localFile = resolveUserRecipe(source)
          if (localFile) {
            console.error(output.fmt.dim(`using registry recipe "${source}" (local version at ${localFile} is overridden)`))
          }
        } catch (err) {
          const isNotFound = err instanceof CliError && err.code === 'RECIPE_NOT_FOUND'
          if (!isNotFound) {
            console.error(`warning: could not reach recipe registry: ${err instanceof Error ? err.message : String(err)}`)
          }
          const userFile = resolveUserRecipe(source)
          if (userFile) {
            yaml = readFileSync(userFile, 'utf-8')
          } else {
            throw new CliError(`Recipe "${source}" not found in registry or ${getRecipesDir()}`, 'RECIPE_NOT_FOUND')
          }
        }
      } else {
        throw new CliError('Provide a recipe file path, registry name, or --stdin', 'NO_SOURCE')
      }

      const params = extractDynamicParams(cmd)

      let resumeInput: Record<string, unknown> | undefined
      if (opts.input) {
        try {
          resumeInput = JSON.parse(opts.input as string) as Record<string, unknown>
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'parse error'
          throw new CliError(`Invalid JSON for --input: ${detail}`, 'INVALID_INPUT')
        }
      }

      let result: RecipeAwaitingAgent | RecipeComplete

      const structured = formatFlag === 'json' || formatFlag === 'toon'
      const aixbt = output.fmt.brand('AIXBT')

      /** Execute on server then enrich any provider fallbacks locally. */
      async function callServerAndEnrich(
        serverOpts: { resumeFromStep?: string; resumeInput?: Record<string, unknown>; carryForward?: Record<string, unknown> } = {},
      ): Promise<RecipeAwaitingAgent | RecipeComplete> {
        const res = await executeRecipeServer({
          yaml,
          params,
          clientOptions,
          ...serverOpts,
        })
        const enrichedData = await enrichServerResponse(res.data)
        return { ...res, data: enrichedData }
      }

      if (adapter && !structured) {
        // Agent mode: AIXBT with trailing spinner -> tick on success
        let fi = 0
        const tick = verbosity < 1 ? setInterval(() => {
          process.stderr.write(`\r${aixbt} ${SPINNER_FRAMES[fi++ % SPINNER_FRAMES.length]}`)
        }, 80) : undefined
        try {
          result = await callServerAndEnrich({
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
          })
          if (tick) clearInterval(tick)
          if (!verbosity) process.stderr.write(`\r${aixbt} ${output.fmt.dim('✓')}\n`)
        } catch (err) {
          if (tick) clearInterval(tick)
          if (!verbosity) process.stderr.write(`\r${aixbt} ${output.fmt.red('✗')}\n`)
          throw err
        }
      } else if (adapter && structured) {
        // Structured format with agent — quiet execution, no visual chrome
        result = await callServerAndEnrich({
          resumeFromStep: opts.resumeFrom as string | undefined,
          resumeInput,
        })
      } else {
        let noAgentFi = 0
        let noAgentInterval: ReturnType<typeof setInterval> | undefined
        if (!structured && verbosity < 1) {
          noAgentInterval = setInterval(() => {
            process.stderr.write(`\r${SPINNER_FRAMES[noAgentFi++ % SPINNER_FRAMES.length]} ${output.fmt.dim('Executing recipe...')}`)
          }, 80)
        }
        try {
          result = await callServerAndEnrich({
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
          })
          if (noAgentInterval) {
            clearInterval(noAgentInterval)
            process.stderr.write('\r\x1b[K')
          }
        } catch (err) {
          if (noAgentInterval) {
            clearInterval(noAgentInterval)
            process.stderr.write('\r\x1b[K')
          }
          throw err
        }
      }

      const outputDir = opts.outputDir as string | undefined

      // No agent — output as-is (existing behavior)
      if (!adapter) {
        const final = outputDir && result.status === 'complete'
          ? applyOutputDir(result, outputDir, recipeFormat)
          : result
        output.outputStructured(final, recipeFormat)
        return
      }

      // Agent orchestration loop: handle intermediate agent steps
      while (result.status === 'awaiting_agent') {
        const awaiting = result
        let agentResponse: Record<string, unknown>

        if (awaiting.parallel) {
          // Parallel agent step — fan out
          agentResponse = await handleParallelAgentStep(adapter, awaiting, structured, agentAllowedTools)
        } else if (structured) {
          agentResponse = await invokeAgentForStep(adapter, awaiting, { allowedTools: agentAllowedTools })
        } else {
          // Visual mode: show agent label + spinner for intermediate step
          const agentColor = AGENT_COLORS[adapter.binary] ?? '#888888'
          const agentLabel = chalk.hex(agentColor)(adapter.binary.toUpperCase())
          process.stderr.write(`  ${chalk.dim('↓')}\n`)
          let fi = 0
          const stepTick = setInterval(() => {
            process.stderr.write(`\r${agentLabel} ${SPINNER_FRAMES[fi++ % SPINNER_FRAMES.length]} ${chalk.dim(`step: ${awaiting.step}`)}`)
          }, 80)
          try {
            agentResponse = await invokeAgentForStep(adapter, awaiting, { allowedTools: agentAllowedTools })
            clearInterval(stepTick)
            process.stderr.write(`\r\x1b[K${agentLabel} ${output.fmt.dim('✓')} ${chalk.dim(`step: ${awaiting.step}`)}\n`)
          } catch (err) {
            clearInterval(stepTick)
            process.stderr.write(`\r\x1b[K${agentLabel} ${output.fmt.red('✗')} ${chalk.dim(`step: ${awaiting.step}`)}\n`)
            throw err
          }
        }

        if (structured) {
          result = await callServerAndEnrich({
            resumeFromStep: `step:${awaiting.step}`,
            resumeInput: agentResponse,
            carryForward: awaiting.carryForward,
          })
        } else {
          // Visual mode: AIXBT spinner for recipe resume
          if (verbosity < 1) process.stderr.write(`  ${chalk.dim('↓')}\n`)
          let fi = 0
          const resumeTick = verbosity < 1 ? setInterval(() => {
            process.stderr.write(`\r${aixbt} ${SPINNER_FRAMES[fi++ % SPINNER_FRAMES.length]}`)
          }, 80) : undefined
          try {
            result = await callServerAndEnrich({
              resumeFromStep: `step:${awaiting.step}`,
              resumeInput: agentResponse,
              carryForward: awaiting.carryForward,
            })
            if (resumeTick) clearInterval(resumeTick)
            if (!verbosity) process.stderr.write(`\r${aixbt} ${output.fmt.dim('✓')}\n`)
          } catch (err) {
            if (resumeTick) clearInterval(resumeTick)
            if (!verbosity) process.stderr.write(`\r${aixbt} ${output.fmt.red('✗')}\n`)
            throw err
          }
        }
      }

      // Apply output-dir if specified (writes segment data to files for codex agent)
      const finalResult = outputDir && result.status === 'complete'
        ? applyOutputDir(result as RecipeComplete, outputDir, recipeFormat)
        : result

      // Recipe complete — handle final analysis
      if (finalResult.analysis && !structured) {
        const recipeSteps = parseRecipeLocal(yaml).steps
        const observe = opts.observe !== false
        await invokeAgentForAnalysis(adapter, finalResult, { allowedTools: agentAllowedTools, recipeSteps, observe })
        console.error('')
      } else if (finalResult.analysis && structured) {
        const { text: analysisText, dataDir } = await captureAgentAnalysis(adapter, finalResult, { allowedTools: agentAllowedTools })
        output.outputStructured({ ...finalResult, analysis_result: analysisText, meta: { dataDir } }, recipeFormat)
      } else {
        output.outputStructured(finalResult, recipeFormat)
      }
    })
}
