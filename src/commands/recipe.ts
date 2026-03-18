import type { Command } from 'commander'
import { readFileSync, existsSync, writeFileSync, mkdirSync, globSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Recipe } from '../types.js'
import { isAgentStep, isForeachStep, isTransformStep } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipe } from '../lib/recipe/engine.js'
import { parseRecipe } from '../lib/recipe/parser.js'
import { validateRecipeCollectIssues } from '../lib/recipe/validator.js'
import { CliError, RecipeValidationError } from '../lib/errors.js'
import { readConfig, resolveFormat, getRecipesDir } from '../lib/config.js'
import { fetchRecipeList, fetchRecipeDetail, fetchRecipeFromRegistry } from '../lib/registry.js'
import type { OutputFormat } from '../lib/output.js'
import * as output from '../lib/output.js'
import { resolveAdapter, resolveAgentTarget, invokeAgentForStep, invokeAgentForAnalysis } from '../lib/agents/index.js'

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
      console.error(`  x ${issue.message}${location}`)
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
    }, outputFormat)
    return
  }

  output.success(`${file} is valid`)

  const agentSteps = recipe.steps.filter(isAgentStep).map((s) => s.id)
  const foreachSteps = recipe.steps.filter(isForeachStep).map((s) => s.id)
  const paramCount = recipe.params ? Object.keys(recipe.params).length : 0

  output.keyValue('Recipe', recipe.name, 20)
  output.keyValue('Version', recipe.version, 20)
  output.keyValue('Steps', String(recipe.steps.length), 20)
  output.keyValue('Params', String(paramCount), 20)

  if (agentSteps.length > 0) {
    output.keyValue('Agent steps', agentSteps.join(', '), 20)
  }
  if (foreachSteps.length > 0) {
    output.keyValue('Foreach steps', foreachSteps.join(', '), 20)
  }
  if (recipe.analysis?.instructions) {
    output.keyValue('', 'Includes analysis instructions', 20)
  }
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

function resolveFilePaths(paths: string[]): string[] {
  const files: string[] = []
  for (const p of paths) {
    if (p.includes('*') || p.includes('?')) {
      files.push(...globSync(p).filter(f => f.endsWith('.yaml') || f.endsWith('.yml')))
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
      `  Recipes are multi-step analysis pipelines defined in YAML. They chain`,
      `  API calls, assemble data, and produce structured prompts for LLM analysis.`,
      '',
      `  As an agent, the most powerful way you can leverage AIXBT data is by`,
      `  running existing recipes from the registry or constructing custom`,
      `  pipelines for your user. Check the registry and guide to dive deeper.`,
      '',
      `  ${output.fmt.dim('Registry')}  aixbt recipe list`,
      `  ${output.fmt.dim('Docs')}      ${output.fmt.link('https://docs.aixbt.tech/builders/cli/recipes')}`,
      '',
      `  ${output.fmt.boldWhite('Agent integration')}`,
      `  Use --agent to spawn an isolated inference session for recipe steps.`,
      `  This calls your locally installed Claude Code or Codex CLI — the`,
      `  agent works in a clean context with only the recipe data, freeing`,
      `  the caller to multitask and allowing use of high-thinking models.`,
      '',
      `  ${output.fmt.dim('Available agents:')}  claude, codex`,
      `  ${output.fmt.dim('Example:')}           aixbt recipe run momentum-report --agent claude`,
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

      // Helper to print a local recipe entry
      const printLocalRecipe = ({ file, recipe, valid }: LocalRecipe) => {
        console.log()
        console.log(`  ${output.fmt.brandBold(recipe.name)}  ${output.fmt.dim(`v${recipe.version}`)}  ${output.fmt.dim(file)}`)
        console.log(`  ${recipe.description}`)

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
        console.log(`  ${r.description}`)

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
        } catch {
          // Not in registry — check user recipes dir
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
        if (isAgentStep(step)) {
          return { id: step.id, type: 'agent' as const, task: step.task }
        }
        if (isForeachStep(step)) {
          return { id: step.id, type: 'foreach' as const, action: step.action, source: step.source }
        }
        if (isTransformStep(step)) {
          return { id: step.id, type: 'transform' as const, input: step.input }
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
        if (isAgentStep(step)) {
          output.keyValue(step.id, `${output.fmt.cyan('agent')} ${output.fmt.dim(step.task)}`, 20)
        } else if (isForeachStep(step)) {
          const label = step.source ? `${step.action} (${step.source})` : step.action
          output.keyValue(step.id, `${output.fmt.cyan('foreach')} ${output.fmt.dim(step.foreach)} ${output.fmt.green('→')} ${output.fmt.dim(label)}`, 20)
        } else if (isTransformStep(step)) {
          output.keyValue(step.id, `${output.fmt.cyan('transform')} ${output.fmt.dim(step.input)}`, 20)
        } else {
          const label = step.source ? `${step.action} (${step.source})` : step.action
          output.keyValue(step.id, `${output.fmt.cyan('api')} ${output.fmt.dim(label)}`, 20)
        }
      }

      if (parsed.analysis?.instructions) {
        console.log()
        output.info('Analysis:')
        output.keyValue('Instructions', parsed.analysis.instructions, 20)
        if (parsed.analysis.task) output.keyValue('Task', parsed.analysis.task, 20)
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
    .description('Download a recipe from the registry to a local file')
    .option('--out <path>', 'Output file path (default: ./<name>.yaml)')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)
      const recipesDir = getRecipesDir()
      const outPath = (opts.out as string) ?? join(recipesDir, `${name}.yaml`)

      if (existsSync(outPath)) {
        throw new CliError(`File already exists: ${outPath}. Use --out to specify a different path`, 'FILE_EXISTS')
      }

      const detail = await output.withSpinner(
        `Fetching recipe "${name}"...`,
        outputFormat,
        () => fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined }),
        `Failed to fetch recipe "${name}"`,
      )

      try {
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, detail.yaml, 'utf-8')
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown write error'
        throw new CliError(`Failed to write ${outPath}: ${msg}`, 'WRITE_FAILED')
      }

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({ status: 'cloned', name, path: outPath }, outputFormat)
      } else {
        output.success(`Recipe saved to ${outPath}`)
        output.dim(`Run with: aixbt recipe run ${outPath}`)
      }
    })

  recipe
    .command('validate <file>')
    .description('Validate a recipe YAML file without executing')
    .action(async (file: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      if (!existsSync(file)) {
        throw new CliError(`File not found: ${file}`, 'FILE_NOT_FOUND')
      }

      const yamlString = readFileSync(file, 'utf-8')

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
    .command('run [source]')
    .description('Execute a recipe (file path, registry name, or --stdin)')
    .option('--stdin', 'Read recipe YAML from stdin')
    .option('--resume-from <step>', 'Resume from an agent step (step:<id>)')
    .option('--input <json>', 'Agent step result JSON (used with --resume-from)')
    .option('--output-dir <path>', 'Write segment data to files instead of stdout')
    .option('--agent <target>', 'Spawn an agent for inference steps: claude, codex')
    .allowUnknownOption(true)
    .action(async (source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const { clientOpts: clientOptions } = getClientOptions(cmd)
      const formatFlag = cmd.optsWithGlobals().format as string | undefined
      if (formatFlag === 'human') {
        throw new CliError(
          'Recipes do not support --format human. Use --format json or --format toon.',
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
        } catch {
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

      let result = await output.withSpinner(
        adapter ? 'Fetching data...' : 'Executing recipe...',
        recipeFormat,
        () =>
          executeRecipe({
            yaml,
            params,
            clientOptions,
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
            outputDir: opts.outputDir as string | undefined,
            outputFormat: recipeFormat,
            recipeSource: opts.stdin ? undefined : source,
          }),
        adapter ? 'Failed to fetch data' : 'Recipe execution failed',
      )

      // No agent — output as-is (existing behavior)
      if (!adapter) {
        output.outputStructured(result, recipeFormat)
        return
      }

      // Agent orchestration loop: handle intermediate agent steps
      while (result.status === 'awaiting_agent') {
        const awaiting = result
        const agentResponse = await output.withSpinner(
          `Agent (${agentTarget}) processing step "${awaiting.step}"...`,
          recipeFormat,
          () => invokeAgentForStep(adapter, awaiting),
          `Agent failed on step "${awaiting.step}"`,
        )

        result = await output.withSpinner(
          'Resuming recipe...',
          recipeFormat,
          () =>
            executeRecipe({
              yaml,
              params,
              clientOptions,
              resumeFromStep: `step:${awaiting.step}`,
              resumeInput: agentResponse,
              outputDir: opts.outputDir as string | undefined,
              outputFormat: recipeFormat,
              recipeSource: opts.stdin ? undefined : source,
            }),
          'Recipe execution failed',
        )
      }

      // Recipe complete — handle final analysis if present
      if (result.analysis?.instructions) {
        console.error('')
        await invokeAgentForAnalysis(adapter, result)
        console.error('')
      } else {
        output.outputStructured(result, recipeFormat)
      }
    })
}
