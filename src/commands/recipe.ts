import type { Command } from 'commander'
import { readFileSync, existsSync } from 'node:fs'
import type { Recipe } from '../types.js'
import { isAgentStep, isForeachStep } from '../types.js'
import { getClientOptions } from '../lib/auth.js'
import { executeRecipe } from '../lib/recipe-engine.js'
import { parseRecipe } from '../lib/recipe-parser.js'
import { validateRecipeCollectIssues } from '../lib/recipe-validator.js'
import { RecipeValidationError } from '../lib/errors.js'
import * as output from '../lib/output.js'

// -- Helpers --

function reportValidationResults(
  file: string,
  issues: Array<{ path: string; message: string }>,
  isJson: boolean,
): void {
  if (issues.length === 0) return

  if (isJson) {
    output.json({
      status: 'invalid',
      file,
      issueCount: issues.length,
      issues,
    })
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

function printValidRecipeSummary(file: string, recipe: Recipe, isJson: boolean): void {
  if (isJson) {
    output.json({
      status: 'valid',
      recipe: recipe.name,
      version: recipe.version,
      stepCount: recipe.steps.length,
      paramCount: recipe.params ? Object.keys(recipe.params).length : 0,
    })
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
    .command('validate <file>')
    .description('Validate a recipe YAML file without executing')
    .action(async (file: string, _opts: unknown, cmd: Command) => {
      const globalOpts = cmd.optsWithGlobals()
      const isJson = globalOpts.json === true

      if (!existsSync(file)) {
        if (isJson) {
          output.json({ status: 'invalid', file, issueCount: 1, issues: [{ path: '', message: `File not found: ${file}` }] })
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
          reportValidationResults(file, err.issues, isJson)
          process.exit(1)
        }
        throw err
      }

      const issues = validateRecipeCollectIssues(recipe)
      if (issues.length > 0) {
        reportValidationResults(file, issues, isJson)
        process.exit(1)
      }

      printValidRecipeSummary(file, recipe, isJson)
    })

  recipe
    .command('run [source]')
    .description('Execute a recipe (file path or --stdin)')
    .option('--stdin', 'Read recipe YAML from stdin')
    .option('--format <mode>', 'Output format: prompt (default) or raw', 'prompt')
    .option('--resume-from <step>', 'Resume from an agent step (step:<id>)')
    .option('--input <json>', 'Agent step result JSON (used with --resume-from)')
    .option('--output-dir <path>', 'Write segment data to files instead of stdout')
    .allowUnknownOption(true)
    .action(async (source: string | undefined, opts: Record<string, unknown>, cmd: Command) => {
      const { clientOpts: clientOptions, isJson } = getClientOptions(cmd)

      let yaml: string
      if (opts.stdin) {
        yaml = await readStdin()
      } else if (source && existsSync(source)) {
        yaml = readFileSync(source, 'utf-8')
      } else if (source) {
        // Bare name — registry not yet available
        if (isJson) {
          output.json({ error: 'REGISTRY_NOT_AVAILABLE', message: 'Registry not yet available. Provide a file path or use --stdin.' })
        } else {
          output.error('Registry not yet available. Provide a file path or use --stdin.')
        }
        process.exit(1)
      } else {
        if (isJson) {
          output.json({ error: 'NO_SOURCE', message: 'Provide a recipe file path or --stdin' })
        } else {
          output.error('Provide a recipe file path or --stdin')
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
          if (isJson) {
            output.json({ error: 'INVALID_INPUT', message: `Invalid JSON for --input: ${detail}` })
          } else {
            output.error(`Invalid JSON for --input: ${detail}`)
          }
          process.exit(1)
        }
      }

      const result = await output.withSpinner(
        'Executing recipe...',
        isJson,
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

      if (opts.format === 'raw' && result.status === 'complete') {
        output.json({ status: 'complete', data: result.data })
      } else {
        output.json(result)
      }
    })
}
