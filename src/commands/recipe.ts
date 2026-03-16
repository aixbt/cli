import type { Command } from 'commander'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import type { Recipe } from '../types.js'
import { isAgentStep, isForeachStep, isTransformStep } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipe } from '../lib/recipe/engine.js'
import { parseRecipe } from '../lib/recipe/parser.js'
import { validateRecipeCollectIssues } from '../lib/recipe/validator.js'
import { CliError, RecipeValidationError } from '../lib/errors.js'
import { resolveFormat } from '../lib/config.js'
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
  const recipe = program.command('recipe').description('Build and run analysis pipelines')

  recipe.addHelpText('after', () => {
    return [
      '',
      `  Recipes are multi-step analysis pipelines defined in YAML. They chain`,
      `  API calls, assemble data, and produce structured prompts for LLM analysis.`,
      '',
      `  As an agent, the most powerful way you can leverage AIXBT data is by`,
      `  constructing recipe pipelines for your user. Check our registry and the`,
      `  guide to dive deeper.`,
      '',
      `  ${output.fmt.dim('Registry')}  aixbt recipe list`,
      `  ${output.fmt.dim('Docs')}      ${output.fmt.link('https://docs.aixbt.tech/builders/cli/recipes')}`,
      '',
    ].join('\n')
  })

  recipe
    .command('list')
    .description('List available recipes from the AIXBT registry')
    .action(async (_opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      const recipes = await output.withSpinner(
        'Fetching recipes...',
        outputFormat,
        () => fetchRecipeList({ apiUrl: globalOpts.apiUrl as string | undefined }),
        'Failed to fetch recipes',
        { silent: true },
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
      console.log()
      output.dim(`${recipes.length} recipes`)
      output.hint('Run aixbt recipe info <name> for details')
    })

  recipe
    .command('info <name>')
    .description('Show details of a recipe from the AIXBT registry')
    .action(async (name: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)

      const detail = await output.withSpinner(
        'Fetching recipe...',
        outputFormat,
        () => fetchRecipeDetail(name, { apiUrl: globalOpts.apiUrl as string | undefined }),
        'Failed to fetch recipe',
        { silent: true },
      )

      const parsed = parseRecipe(detail.yaml)

      const steps = parsed.steps.map((step) => {
        if (isAgentStep(step)) {
          return { id: step.id, type: 'agent' as const, task: step.task }
        }
        if (isForeachStep(step)) {
          return { id: step.id, type: 'foreach' as const, endpoint: step.endpoint }
        }
        if (isTransformStep(step)) {
          return { id: step.id, type: 'transform' as const, input: step.input }
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
      output.keyValue('Version', output.fmt.number(parsed.version), 20)
      output.keyValue('Description', parsed.description, 20)
      output.keyValue('Updated', detail.updatedAt, 20)
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
          output.keyValue(step.id, `${output.fmt.cyan('foreach')} ${output.fmt.dim(step.foreach)} ${output.fmt.green('→')} ${output.fmt.dim(step.endpoint)}`, 20)
        } else if (isTransformStep(step)) {
          output.keyValue(step.id, `${output.fmt.cyan('transform')} ${output.fmt.dim(step.input)}`, 20)
        } else {
          output.keyValue(step.id, `${output.fmt.cyan('api')} ${output.fmt.dim(step.endpoint)}`, 20)
        }
      }

      if (parsed.analysis?.instructions) {
        console.log()
        output.info('Analysis:')
        output.keyValue('Instructions', parsed.analysis.instructions, 20)
        if (parsed.analysis.task) output.keyValue('Task', parsed.analysis.task, 20)
        if (parsed.analysis.output) output.keyValue('Output', parsed.analysis.output, 20)
      }
    })

  recipe
    .command('clone <name>')
    .description('Download a recipe from the registry to a local file')
    .option('--out <path>', 'Output file path (default: ./<name>.yaml)')
    .action(async (name: string, opts: Record<string, unknown>, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const outputFormat = resolveFormat(globalOpts.format as string | undefined)
      const outPath = (opts.out as string) ?? `./${name}.yaml`

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

      let yaml: string
      if (opts.stdin) {
        yaml = await readStdin()
      } else if (source && existsSync(source)) {
        yaml = readFileSync(source, 'utf-8')
      } else if (source && (source.includes('/') || source.endsWith('.yaml') || source.endsWith('.yml'))) {
        throw new CliError(`File not found: ${source}`, 'FILE_NOT_FOUND')
      } else if (source) {
        yaml = await fetchRecipeFromRegistry(source, clientOptions)
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

      const result = await output.withSpinner(
        'Executing recipe...',
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
        'Recipe execution failed',
      )

      output.outputStructured(result, recipeFormat)
    })
}
