import type { Command } from 'commander'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import type { Recipe } from '../types.js'
import { isAgentStep, isForeachStep, isTransformStep } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipe } from '../lib/recipe-engine.js'
import { parseRecipe } from '../lib/recipe-parser.js'
import { validateRecipeCollectIssues } from '../lib/recipe-validator.js'
import { CliError, RecipeValidationError } from '../lib/errors.js'
import { fetchRecipeList, fetchRecipeDetail, fetchRecipeFromRegistry } from '../lib/registry.js'
import type { OutputFormat } from '../lib/output.js'
import * as output from '../lib/output.js'

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

// -- Command registration --

export function registerRecipeCommand(program: Command): void {
  const recipe = program.command('recipe').description('Run analysis recipes')

  recipe
    .command('list')
    .description('List available recipes from the AIXBT registry')
    .action(async (_opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = (globalOpts.format as OutputFormat) ?? 'table'

      const recipes = await output.withSpinner(
        'Fetching recipes...',
        outputFormat,
        () => fetchRecipeList({ apiUrl: globalOpts.apiUrl as string | undefined }),
        'Failed to fetch recipes',
      )

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured(recipes, outputFormat)
        return
      }

      if (recipes.length === 0) {
        output.dim('No recipes available.')
        return
      }

      for (const r of recipes) {
        console.log()
        const tokenLabel = r.estimatedTokens
          ? output.fmt.dim(`~${Math.round(r.estimatedTokens / 1000)}k tokens`)
          : ''
        console.log(`  ${output.fmt.brandBold(r.name)}  ${output.fmt.dim(`v${r.version}`)}${tokenLabel ? `  ${tokenLabel}` : ''}`)
        console.log(`  ${r.description}`)
        if (r.paramCount > 0) {
          console.log(`  ${output.fmt.dim(`${r.paramCount} param${r.paramCount !== 1 ? 's' : ''} — run`)} aixbt recipe info ${r.name} ${output.fmt.dim('for details')}`)
        }
      }
      console.log()
      output.dim(`${recipes.length} recipes`)
    })

  recipe
    .command('info <name>')
    .description('Show details of a recipe from the AIXBT registry')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = (globalOpts.format as OutputFormat) ?? 'table'

      const detail = await output.withSpinner(
        'Fetching recipe...',
        outputFormat,
        () => fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined }),
        'Failed to fetch recipe',
      )

      const parsed = parseRecipe(detail.yaml)

      const steps = parsed.steps.map((step) => {
        if (isAgentStep(step)) {
          return { id: step.id, type: 'agent' as const, task: step.task }
        }
        if (isForeachStep(step)) {
          return { id: step.id, type: 'foreach' as const, endpoint: step.endpoint }
        }
        return { id: step.id, type: 'api' as const, endpoint: step.endpoint }
      })

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured({
          name: parsed.name,
          version: parsed.version,
          description: parsed.description,
          updatedAt: detail.updatedAt,
          estimatedTokens: parsed.estimatedTokens ?? null,
          params: parsed.params ?? {},
          stepCount: parsed.steps.length,
          steps,
          hasAnalysis: !!parsed.analysis?.instructions,
          yaml: detail.yaml,
        }, outputFormat)
        return
      }

      output.label('Recipe', parsed.name)
      output.keyValue('Version', parsed.version, 20)
      output.keyValue('Description', parsed.description, 20)
      output.keyValue('Updated', detail.updatedAt, 20)
      output.keyValue('Steps', String(parsed.steps.length), 20)
      if (parsed.estimatedTokens) {
        output.keyValue('Est. tokens', `~${Math.round(parsed.estimatedTokens / 1000)}k`, 20)
      }

      if (parsed.params && Object.keys(parsed.params).length > 0) {
        console.log()
        output.info('Parameters:')
        for (const [key, param] of Object.entries(parsed.params)) {
          const parts: string[] = []
          if (param.description) parts.push(param.description)
          if (param.required) parts.push('(required)')
          if (param.default !== undefined) parts.push(`[default: ${param.default}]`)
          output.keyValue(`--${key}`, parts.join(' '), 20)
        }
      }

      console.log()
      output.info('Steps:')
      for (const step of parsed.steps) {
        if (isAgentStep(step)) {
          output.keyValue(step.id, `agent (${step.task})`, 20)
        } else if (isForeachStep(step)) {
          output.keyValue(step.id, `foreach ${step.foreach} -> ${step.endpoint}`, 20)
        } else if (isTransformStep(step)) {
          output.keyValue(step.id, `transform ${step.input}`, 20)
        } else {
          output.keyValue(step.id, step.endpoint, 20)
        }
      }

      if (parsed.analysis?.instructions) {
        console.log()
        output.dim('  Includes analysis instructions')
      }
    })

  recipe
    .command('clone <name>')
    .description('Download a recipe from the registry to a local file')
    .option('--out <path>', 'Output file path (default: ./<name>.yaml)')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = (globalOpts.format as OutputFormat) ?? 'table'
      const outPath = (opts.out as string) ?? `./${name}.yaml`

      if (existsSync(outPath)) {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ error: 'FILE_EXISTS', message: `File already exists: ${outPath}`, path: outPath }, outputFormat)
        } else {
          output.error(`File already exists: ${outPath}`)
          output.dim('Use --out to specify a different path')
        }
        process.exit(1)
      }

      const detail = await output.withSpinner(
        `Fetching recipe "${name}"...`,
        outputFormat,
        () => fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined }),
        `Failed to fetch recipe "${name}"`,
      )

      try {
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
      const outputFormat = (globalOpts.format as OutputFormat) ?? 'table'

      if (!existsSync(file)) {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ status: 'invalid', file, issueCount: 1, issues: [{ path: '', message: `File not found: ${file}` }] }, outputFormat)
        } else {
          output.error(`File not found: ${file}`)
        }
        process.exit(1)
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
    .allowUnknownOption(true)
    .action(async (source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const { clientOpts: clientOptions, outputFormat } = getClientOptions(cmd)

      let yaml: string
      if (opts.stdin) {
        yaml = await readStdin()
      } else if (source && existsSync(source)) {
        yaml = readFileSync(source, 'utf-8')
      } else if (source && (source.includes('/') || source.endsWith('.yaml') || source.endsWith('.yml'))) {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ error: 'FILE_NOT_FOUND', message: `File not found: ${source}` }, outputFormat)
        } else {
          output.error(`File not found: ${source}`)
        }
        process.exit(1)
      } else if (source) {
        yaml = await fetchRecipeFromRegistry(source, clientOptions)
      } else {
        if (output.isStructuredFormat(outputFormat)) {
          output.outputStructured({ error: 'NO_SOURCE', message: 'Provide a recipe file path, registry name, or --stdin' }, outputFormat)
        } else {
          output.error('Provide a recipe file path, registry name, or --stdin')
        }
        process.exit(1)
      }

      const params = extractDynamicParams(cmd)

      let resumeInput: Record<string, unknown> | undefined
      if (opts.input) {
        try {
          resumeInput = JSON.parse(opts.input as string) as Record<string, unknown>
        } catch (err) {
          const detail = err instanceof Error ? err.message : 'parse error'
          if (output.isStructuredFormat(outputFormat)) {
            output.outputStructured({ error: 'INVALID_INPUT', message: `Invalid JSON for --input: ${detail}` }, outputFormat)
          } else {
            output.error(`Invalid JSON for --input: ${detail}`)
          }
          process.exit(1)
        }
      }

      const result = await output.withSpinner(
        'Executing recipe...',
        outputFormat,
        () =>
          executeRecipe({
            yaml,
            params,
            clientOptions,
            resumeFromStep: opts.resumeFrom as string | undefined,
            resumeInput,
            outputDir: opts.outputDir as string | undefined,
            recipeSource: opts.stdin ? undefined : source,
          }),
        'Recipe execution failed',
      )

      if (output.isStructuredFormat(outputFormat)) {
        output.outputStructured(result, outputFormat)
      } else {
        output.json(result)
      }
    })
}
