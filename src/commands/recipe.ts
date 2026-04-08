import type { Command } from 'commander'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { globSync } from 'tinyglobby'
import { parse as parseYaml } from 'yaml'
import type { Recipe, RecipeAwaitingAgent } from '../types.js'
import { isAgentStep, isParallelAgentStep, hasForModifier } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipe } from '../lib/recipe/engine.js'
import { measureRecipe } from '../lib/recipe/measure.js'
import { parseRecipe } from '../lib/recipe/parser.js'
import { validateRecipeCollectIssues } from '../lib/recipe/validator.js'
import { CliError, RecipeValidationError } from '../lib/errors.js'
import { readConfig, resolveFormat, getRecipesDir } from '../lib/config.js'
import { fetchRecipeList, fetchRecipeDetail, fetchRecipeFromRegistry } from '../lib/registry.js'
import type { OutputFormat } from '../lib/output.js'
import * as output from '../lib/output.js'
import chalk from 'chalk'
import type { AgentAdapter } from '../lib/agents/index.js'
import { resolveAdapter, resolveAgentTarget, invokeAgentForStep, invokeAgentForAnalysis, captureAgentAnalysis, invokeParallelAgents, AGENT_COLORS } from '../lib/agents/index.js'

const PARALLEL_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']

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
    process.stderr.write(`\r${agentLabel} ${PARALLEL_FRAMES[fi++ % PARALLEL_FRAMES.length]} ${chalk.dim(`step: ${awaiting.step} [${completedCount}/${total}]`)}`)
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

function printValidRecipeSummary(file: string, recipe: Recipe, outputFormat: OutputFormat): void {
  if (output.isStructuredFormat(outputFormat)) {
    output.outputStructured({
      status: 'valid',
      recipe: recipe.name,
      version: recipe.version,
      stepCount: recipe.steps.length,
      paramCount: recipe.params ? Object.keys(recipe.params).length : 0,
      hint: `Run 'aixbt recipe measure ${recipe.name}' to check context token usage`,
    }, outputFormat)
    return
  }

  output.success(`${file} is valid`)

  const agentSteps = recipe.steps.filter(isAgentStep).map((s) => s.id)
  const forSteps = recipe.steps.filter(hasForModifier).map((s) => s.id)
  const paramCount = recipe.params ? Object.keys(recipe.params).length : 0

  output.keyValue('Recipe', recipe.name, 20)
  output.keyValue('Version', recipe.version, 20)
  output.keyValue('Steps', String(recipe.steps.length), 20)
  output.keyValue('Params', String(paramCount), 20)

  if (agentSteps.length > 0) {
    output.keyValue('Agent steps', agentSteps.join(', '), 20)
  }
  if (forSteps.length > 0) {
    output.keyValue('Iterated steps', forSteps.join(', '), 20)
  }
  if (recipe.analysis?.instructions) {
    output.keyValue('Analysis', 'Yes', 20)
  }
  output.hint(`Next: aixbt recipe measure ${recipe.name}`)
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
      try { parseRecipe(yamlContent) } catch { valid = false }

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

      const isFilePath = name.includes('/') || name.endsWith('.yaml') || name.endsWith('.yml')

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

      const parsed = parseRecipe(yaml)

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
    .command('validate <name>')
    .description('Validate a recipe YAML file without executing')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      let file = name
      let yamlString: string
      if (existsSync(name)) {
        yamlString = readFileSync(name, 'utf-8')
      } else if (name.includes('/') || name.endsWith('.yaml') || name.endsWith('.yml')) {
        throw new CliError(`File not found: ${name}`, 'FILE_NOT_FOUND')
      } else {
        const userFile = resolveUserRecipe(name)
        if (userFile) {
          yamlString = readFileSync(userFile, 'utf-8')
          file = userFile
        } else {
          throw new CliError(`Recipe "${name}" not found in ${getRecipesDir()}`, 'RECIPE_NOT_FOUND')
        }
      }

      let recipe: Recipe
      try {
        recipe = parseRecipe(yamlString)
      } catch (err) {
        if (err instanceof RecipeValidationError) {
          reportValidationResults(file, err.issues, outputFormat)
          process.exit(1)
        }
        throw err
      }

      const issues = validateRecipeCollectIssues(recipe)
      if (issues.length > 0) {
        reportValidationResults(file, issues, outputFormat)
        process.exit(1)
      }

      printValidRecipeSummary(file, recipe, outputFormat)
    })

  recipe
    .command('measure <name>')
    .description('Run data steps and report context token usage')
    .allowUnknownOption(true)
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const { clientOpts: clientOptions } = getClientOptions(cmd)
      const globalOpts = cmd.optsWithGlobals()
      if (globalOpts.payPerUse) {
        throw new CliError(
          'Pay-per-use is not supported for recipes. Recipes make multiple API calls; use an API key instead.',
          'PAY_PER_USE_UNSUPPORTED',
        )
      }
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      // Resolve recipe source (same logic as info/run)
      let yaml: string
      let source = name
      if (existsSync(name)) {
        yaml = readFileSync(name, 'utf-8')
      } else if (name.includes('/') || name.endsWith('.yaml') || name.endsWith('.yml')) {
        throw new CliError(`File not found: ${name}`, 'FILE_NOT_FOUND')
      } else {
        const userFile = resolveUserRecipe(name)
        if (userFile) {
          yaml = readFileSync(userFile, 'utf-8')
          source = userFile
        } else {
          throw new CliError(`Recipe "${name}" not found in ${getRecipesDir()}`, 'RECIPE_NOT_FOUND')
        }
      }

      const params = extractDynamicParams(cmd)

      // Auto-populate missing required params with Bitcoin project ID for measurement
      const BITCOIN_ID = '66f4fdc76811ccaef955de3e'
      try {
        const parsed = parseRecipe(yaml)
        if (parsed.params) {
          for (const [key, def] of Object.entries(parsed.params)) {
            if (def.required && !params[key] && !def.default) {
              params[key] = BITCOIN_ID
              if (!output.isStructuredFormat(outputFormat)) {
                output.dim(`Auto-populated --${key} with Bitcoin for measurement`)
              }
            }
          }
        }
      } catch { /* validation errors will surface when executeRecipe runs */ }

      const structured = output.isStructuredFormat(outputFormat)

      const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
      let frameIdx = 0
      let spinnerInterval: ReturnType<typeof setInterval> | undefined
      let spinnerLabel = ''

      const upgradeHints: string[] = []

      // Rate limit countdown state
      let rateLimitStart = 0
      let rateLimitWaitMs = 0
      let rateLimitProvider = ''
      let rateLimitProgress = ''

      if (!structured) {
        spinnerLabel = 'Running data steps...'
        spinnerInterval = setInterval(() => {
          let extra = ''
          if (rateLimitStart > 0) {
            const elapsed = Date.now() - rateLimitStart
            const remaining = Math.max(0, Math.ceil((rateLimitWaitMs - elapsed) / 1000))
            if (remaining > 0) {
              extra = ` (${rateLimitProvider}: rate limited, waiting ${remaining}s) ${rateLimitProgress}`
            }
          }
          process.stderr.write(`\r${FRAMES[frameIdx++ % FRAMES.length]} ${output.fmt.dim(`${spinnerLabel}${extra}`)}`)
        }, 80)
      }

      const handleProgress = (event: { type: string; provider: string; waitMs: number; completed: number; total: number; tier?: string; upgradeHint?: string }) => {
        if (event.type === 'rate_limit') {
          rateLimitStart = Date.now()
          rateLimitWaitMs = event.waitMs
          rateLimitProvider = event.provider
          rateLimitProgress = `[${event.completed}/${event.total}]`
          if (event.upgradeHint && !upgradeHints.includes(event.upgradeHint)) {
            upgradeHints.push(event.upgradeHint)
          }
        } else if (event.type === 'item_complete') {
          rateLimitStart = 0
        }
      }

      try {
        const result = await measureRecipe({
          yaml,
          params,
          clientOptions,
          recipeSource: source,
          onSegment: (label) => { spinnerLabel = label },
          onProgress: handleProgress,
        })

        if (spinnerInterval) {
          clearInterval(spinnerInterval)
          process.stderr.write(`\r${output.fmt.dim('✓')} Measured ${result.segments.length} segment${result.segments.length !== 1 ? 's' : ''}\n`)
        }

        if (upgradeHints.length > 0) {
          for (const hint of upgradeHints) {
            console.error(output.fmt.dim(`  ↳ ${hint}`))
          }
        }

        if (structured) {
          output.outputStructured(result, outputFormat)
          return
        }

        // Human output
        const fmtTokens = (n: number) => n < 1000 ? `~${n}` : `~${Math.round(n / 1000)}k`

        console.log()
        console.log(`${output.fmt.boldWhite(result.recipeName)}  ${output.fmt.dim(source)}`)
        console.log()

        for (const seg of result.segments) {
          const typeTag = seg.type === 'post-yield'
            ? output.fmt.dim('(post-yield, 1 mock item)')
            : ''
          console.log(`${output.fmt.dim(seg.label)} ${typeTag}`)
          console.log(`  json: ${output.fmt.number(fmtTokens(seg.tokens.json))}  toon: ${output.fmt.number(fmtTokens(seg.tokens.toon))}`)
        }

        console.log()
        console.log(`${output.fmt.boldWhite('Total')}`)
        console.log(`  json: ${output.fmt.number(fmtTokens(result.totalTokens.json))}  toon: ${output.fmt.number(fmtTokens(result.totalTokens.toon))}`)

        // Scaling note for multi-segment recipes with post-yield data
        const postYieldSegs = result.segments.filter(s => s.type === 'post-yield')
        if (postYieldSegs.length > 0) {
          const postYieldTotal = {
            json: postYieldSegs.reduce((sum, s) => sum + s.tokens.json, 0),
            toon: postYieldSegs.reduce((sum, s) => sum + s.tokens.toon, 0),
          }
          const dataSegs = result.segments.filter(s => s.type === 'data')
          const dataTotal = {
            json: dataSegs.reduce((sum, s) => sum + s.tokens.json, 0),
            toon: dataSegs.reduce((sum, s) => sum + s.tokens.toon, 0),
          }
          console.log()
          output.dim('Post-yield segments measured with 1 mock item (Bitcoin).')
          output.dim('Scale per-item cost by expected agent pick count:')
          for (const n of [3, 5]) {
            const scaled = {
              json: dataTotal.json + postYieldTotal.json * n,
              toon: dataTotal.toon + postYieldTotal.toon * n,
            }
            console.log(`  ${n} picks: json ${fmtTokens(scaled.json)}  toon ${fmtTokens(scaled.toon)}`)
          }
        }

        console.log()
      } catch (err) {
        if (spinnerInterval) {
          clearInterval(spinnerInterval)
          process.stderr.write(`\r${output.fmt.red('✗')} Measure failed\n`)
        }
        throw err
      }
    })

  recipe
    .command('run [source]')
    .description('Execute a recipe (file path, registry name, or --stdin)')
    .option('--stdin', 'Read recipe YAML from stdin')
    .option('--resume-from <step>', 'Resume from an agent step (step:<id>)')
    .option('--input <json>', 'Agent step result JSON (used with --resume-from)')
    .option('--output-dir <path>', 'Write segment data to files instead of stdout')
    .option('--agent <target>', 'Spawn an agent for inference steps: claude, codex')
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
      } else if (source && (source.includes('/') || source.endsWith('.yaml') || source.endsWith('.yml'))) {
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

      let result: Awaited<ReturnType<typeof executeRecipe>>

      const structured = formatFlag === 'json' || formatFlag === 'toon'
      const FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏']
      const aixbt = output.fmt.brand('AIXBT')
      // Rate limit countdown state for run command
      let runRateLimitStart = 0
      let runRateLimitWaitMs = 0
      let runRateLimitProvider = ''
      let runRateLimitProgress = ''
      const runUpgradeHints: string[] = []

      function getRunRateLimitSuffix(): string {
        if (runRateLimitStart <= 0) return ''
        const elapsed = Date.now() - runRateLimitStart
        const remaining = Math.max(0, Math.ceil((runRateLimitWaitMs - elapsed) / 1000))
        if (remaining <= 0) return ''
        return ` ${output.fmt.dim(`(${runRateLimitProvider}: rate limited, waiting ${remaining}s) ${runRateLimitProgress}`)}`
      }

      const handleRunProgress = (event: { type: string; provider: string; waitMs: number; completed: number; total: number; tier?: string; upgradeHint?: string }) => {
        if (event.type === 'rate_limit') {
          runRateLimitStart = Date.now()
          runRateLimitWaitMs = event.waitMs
          runRateLimitProvider = event.provider
          runRateLimitProgress = `[${event.completed}/${event.total}]`
          if (event.upgradeHint && !runUpgradeHints.includes(event.upgradeHint)) {
            runUpgradeHints.push(event.upgradeHint)
          }
        } else if (event.type === 'item_complete') {
          runRateLimitStart = 0
        }
      }
      if (adapter && !structured) {
        // Agent mode: AIXBT with trailing spinner → tick on success
        // Suppress spinner when verbose — debug lines go to stderr too
        let fi = 0
        const tick = verbosity < 1 ? setInterval(() => {
          process.stderr.write(`\r${aixbt} ${FRAMES[fi++ % FRAMES.length]}${getRunRateLimitSuffix()}`)
        }, 80) : undefined
        try {
          result = await executeRecipe({
            yaml,
            params,
            clientOptions,
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
            outputDir: opts.outputDir as string | undefined,
            outputFormat: recipeFormat,
            recipeSource: opts.stdin ? undefined : source,
            onProgress: handleRunProgress,
            verbosity,
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
        result = await executeRecipe({
          yaml,
          params,
          clientOptions,
          resumeFromStep: opts.resumeFrom as string | undefined,
          resumeInput,
          outputDir: opts.outputDir as string | undefined,
          outputFormat: recipeFormat,
          recipeSource: opts.stdin ? undefined : source,
          onProgress: handleRunProgress,
          verbosity,
        })
      } else {
        let noAgentFi = 0
        let noAgentInterval: ReturnType<typeof setInterval> | undefined
        if (!structured && verbosity < 1) {
          noAgentInterval = setInterval(() => {
            process.stderr.write(`\r${FRAMES[noAgentFi++ % FRAMES.length]} ${output.fmt.dim('Executing recipe...')}${getRunRateLimitSuffix()}`)
          }, 80)
        }
        try {
          result = await executeRecipe({
            yaml,
            params,
            clientOptions,
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
            outputDir: opts.outputDir as string | undefined,
            outputFormat: recipeFormat,
            recipeSource: opts.stdin ? undefined : source,
            onProgress: handleRunProgress,
            verbosity,
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
      if (runUpgradeHints.length > 0 && !structured) {
        for (const hint of runUpgradeHints) {
          console.error(output.fmt.dim(`↳ ${hint}`))
        }
      }

      // No agent — output as-is (existing behavior)
      if (!adapter) {
        output.outputStructured(result, recipeFormat)
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
            process.stderr.write(`\r${agentLabel} ${FRAMES[fi++ % FRAMES.length]} ${chalk.dim(`step: ${awaiting.step}`)}`)
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
          result = await executeRecipe({
            yaml,
            params,
            clientOptions,
            resumeFromStep: `step:${awaiting.step}`,
            resumeInput: agentResponse,
            outputDir: opts.outputDir as string | undefined,
            outputFormat: recipeFormat,
            recipeSource: opts.stdin ? undefined : source,
            onProgress: handleRunProgress,
            verbosity,
            carryForward: awaiting.carryForward,
          })
        } else {
          // Visual mode: AIXBT spinner for recipe resume
          if (verbosity < 1) process.stderr.write(`  ${chalk.dim('↓')}\n`)
          runRateLimitStart = 0
          let fi = 0
          const resumeTick = verbosity < 1 ? setInterval(() => {
            process.stderr.write(`\r${aixbt} ${FRAMES[fi++ % FRAMES.length]}${getRunRateLimitSuffix()}`)
          }, 80) : undefined
          try {
            result = await executeRecipe({
              yaml,
              params,
              clientOptions,
              resumeFromStep: `step:${awaiting.step}`,
              resumeInput: agentResponse,
              outputDir: opts.outputDir as string | undefined,
              outputFormat: recipeFormat,
              recipeSource: opts.stdin ? undefined : source,
              onProgress: handleRunProgress,
              verbosity,
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

      // Recipe complete — handle final analysis
      if (result.analysis && !structured) {
        const recipeSteps = parseRecipe(yaml).steps
        const observe = opts.observe !== false
        await invokeAgentForAnalysis(adapter, result, { allowedTools: agentAllowedTools, recipeSteps, observe })
        console.error('')
      } else if (result.analysis && structured) {
        const { text: analysisText, dataDir } = await captureAgentAnalysis(adapter, result, { allowedTools: agentAllowedTools })
        output.outputStructured({ ...result, analysis_result: analysisText, meta: { dataDir } }, recipeFormat)
      } else {
        output.outputStructured(result, recipeFormat)
      }
    })
}
