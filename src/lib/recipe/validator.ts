import { RecipeValidationError } from '../errors.js'
import type { Recipe, RecipeStep, Segment, AgentStep, ValidationIssue } from '../../types.js'
import { isAgentStep, isForeachStep, isTransformStep, TEMPLATE_REGEX } from '../../types.js'
import { getProviderNames, getProvider } from '../providers/registry.js'

export function extractTemplateRefs(str: string): string[] {
  const refs: string[] = []
  const regex = new RegExp(TEMPLATE_REGEX.source, TEMPLATE_REGEX.flags)
  let match: RegExpExecArray | null
  while ((match = regex.exec(str)) !== null) {
    refs.push(match[1])
  }
  return refs
}

export function extractAllTemplateRefs(obj: unknown): string[] {
  if (typeof obj === 'string') {
    return extractTemplateRefs(obj)
  }

  if (Array.isArray(obj)) {
    const refs: string[] = []
    for (const item of obj) {
      refs.push(...extractAllTemplateRefs(item))
    }
    return refs
  }

  if (typeof obj === 'object' && obj !== null) {
    const refs: string[] = []
    for (const value of Object.values(obj as Record<string, unknown>)) {
      refs.push(...extractAllTemplateRefs(value))
    }
    return refs
  }

  return []
}

export function extractStepReferences(step: RecipeStep): Set<string> {
  const refs = new Set<string>()

  // Transform step: only reference is the input step
  if (isTransformStep(step)) {
    refs.add(step.input)
    return refs
  }

  if (isForeachStep(step)) {
    const foreachRef = step.foreach
    const dotIndex = foreachRef.indexOf('.')
    const stepId = dotIndex === -1 ? foreachRef : foreachRef.slice(0, dotIndex)
    if (stepId !== 'params' && stepId !== 'item') {
      refs.add(stepId)
    }
  }

  const allRefs: string[] = []

  if (!isAgentStep(step)) {
    if (step.params) {
      allRefs.push(...extractAllTemplateRefs(step.params))
    }
    if (step.endpoint) {
      allRefs.push(...extractTemplateRefs(step.endpoint))
    }
  }

  for (const ref of allRefs) {
    const dotIndex = ref.indexOf('.')
    const prefix = dotIndex === -1 ? ref : ref.slice(0, dotIndex)
    if (prefix !== 'params' && prefix !== 'item') {
      refs.add(prefix)
    }
  }

  return refs
}

export function buildSegments(recipe: Recipe): Segment[] {
  const segments: Segment[] = []
  let currentSteps: RecipeStep[] = []
  let precedingAgentStep: AgentStep | undefined

  for (const step of recipe.steps) {
    if (isAgentStep(step)) {
      if (currentSteps.length > 0) {
        // Push the agent step into the current batch, then close the segment
        currentSteps.push(step)
        segments.push({
          index: segments.length,
          steps: currentSteps,
          precedingAgentStep,
        })
      } else if (segments.length === 0) {
        // Agent step at the very beginning — create a segment with just it
        segments.push({
          index: 0,
          steps: [step],
          precedingAgentStep: undefined,
        })
      } else {
        // Agent step immediately after another agent step — push into a new segment alone
        segments.push({
          index: segments.length,
          steps: [step],
          precedingAgentStep,
        })
      }

      precedingAgentStep = step
      currentSteps = []
    } else {
      currentSteps.push(step)
    }
  }

  if (currentSteps.length > 0) {
    segments.push({
      index: segments.length,
      steps: currentSteps,
      precedingAgentStep,
    })
  }

  return segments
}

function validateSegmentBoundaries(
  _recipe: Recipe,
  segments: Segment[],
  issues: ValidationIssue[],
): void {
  for (const segment of segments) {
    const accessible = new Set<string>()

    if (segment.precedingAgentStep) {
      accessible.add(segment.precedingAgentStep.id)
    }

    for (const step of segment.steps) {
      if (isAgentStep(step)) {
        for (const ref of step.context) {
          if (!accessible.has(ref)) {
            const accessibleList = [...accessible].sort()
            issues.push({
              path: `steps.${step.id}.context`,
              message: `Step "${step.id}" references "${ref}" which is not accessible in this segment. Accessible steps: [${accessibleList.join(', ')}]`,
            })
          }
        }
      } else {
        const stepRefs = extractStepReferences(step)
        for (const ref of stepRefs) {
          if (!accessible.has(ref)) {
            const accessibleList = [...accessible].sort()
            issues.push({
              path: `steps.${step.id}`,
              message: `Step "${step.id}" references "${ref}" which is not accessible in this segment. Accessible steps: [${accessibleList.join(', ')}]`,
            })
          }
        }
      }

      accessible.add(step.id)
    }
  }
}

function checkTemplateReferences(
  params: Record<string, unknown> | undefined,
  stepId: string,
  allStepIds: Set<string>,
  paramNames: Set<string>,
  issues: ValidationIssue[],
): void {
  if (!params) return

  const refs = extractAllTemplateRefs(params)
  for (const ref of refs) {
    const dotIndex = ref.indexOf('.')
    const prefix = dotIndex === -1 ? ref : ref.slice(0, dotIndex)

    if (prefix === 'item') continue

    if (prefix === 'params') {
      if (dotIndex !== -1) {
        const paramName = ref.slice(dotIndex + 1)
        if (!paramNames.has(paramName)) {
          issues.push({
            path: `steps.${stepId}.params`,
            message: `References undefined param "${paramName}"`,
          })
        }
      }
      continue
    }

    if (!allStepIds.has(prefix)) {
      issues.push({
        path: `steps.${stepId}.params`,
        message: `References unknown step "${prefix}"`,
      })
    }
  }
}

function validateVariableReferences(
  recipe: Recipe,
  _segments: Segment[],
  issues: ValidationIssue[],
): void {
  const allStepIds = new Set<string>(recipe.steps.map((s) => s.id))
  const paramNames = new Set<string>(
    recipe.params ? Object.keys(recipe.params) : [],
  )

  const stepIdOrder = new Map<string, number>()
  for (let i = 0; i < recipe.steps.length; i++) {
    stepIdOrder.set(recipe.steps[i].id, i)
  }

  for (const step of recipe.steps) {
    if (isAgentStep(step)) continue

    // Transform step: validate input reference
    if (isTransformStep(step)) {
      if (!allStepIds.has(step.input)) {
        issues.push({
          path: `steps.${step.id}.input`,
          message: `References unknown step "${step.input}"`,
        })
      } else {
        const inputIndex = stepIdOrder.get(step.input)!
        const currentIndex = stepIdOrder.get(step.id)!
        if (inputIndex >= currentIndex) {
          issues.push({
            path: `steps.${step.id}.input`,
            message: `input must reference a step that appears earlier in the recipe (referenced "${step.input}")`,
          })
        }
      }
      continue
    }

    // Check foreach references
    if (isForeachStep(step)) {
      const foreachRef = step.foreach
      const dotIndex = foreachRef.indexOf('.')
      const stepId = dotIndex === -1 ? foreachRef : foreachRef.slice(0, dotIndex)
      if (stepId !== 'params' && stepId !== 'item' && !allStepIds.has(stepId)) {
        issues.push({
          path: `steps.${step.id}.foreach`,
          message: `References unknown step "${stepId}"`,
        })
      }
    }

    // Check param template references
    checkTemplateReferences(step.params, step.id, allStepIds, paramNames, issues)

    // Check endpoint template references (only for steps that still have endpoint)
    if (step.endpoint) {
      const endpointRefs = extractTemplateRefs(step.endpoint)
      for (const ref of endpointRefs) {
        const dotIndex = ref.indexOf('.')
        const prefix = dotIndex === -1 ? ref : ref.slice(0, dotIndex)

        if (prefix === 'item') continue

        if (prefix === 'params') {
          if (dotIndex !== -1) {
            const paramName = ref.slice(dotIndex + 1)
            if (!paramNames.has(paramName)) {
              issues.push({
                path: `steps.${step.id}.endpoint`,
                message: `References undefined param "${paramName}"`,
              })
            }
          }
          continue
        }

        if (!allStepIds.has(prefix)) {
          issues.push({
            path: `steps.${step.id}.endpoint`,
            message: `References unknown step "${prefix}"`,
          })
        }
      }
    }
  }
}

export function validateProviderActions(
  recipe: Recipe,
): ValidationIssue[] {
  const knownProviders = getProviderNames()
  // If no providers registered yet, skip validation
  if (knownProviders.length === 0) return []

  const issues: ValidationIssue[] = []

  for (const step of recipe.steps) {
    if (isAgentStep(step) || isTransformStep(step)) continue

    const source = step.source ?? 'aixbt'
    const action = step.action
    if (!action) continue

    // Validate source
    if (!knownProviders.includes(source)) {
      issues.push({
        path: `steps.${step.id}.source`,
        message: `Unknown provider "${source}". Available providers: ${knownProviders.join(', ')}`,
      })
      continue
    }

    // Validate action — skip for raw paths (legacy "GET /v2/..." or "/v2/..." fallback)
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

export function validateRecipeCollectIssues(
  recipe: Recipe,
): Array<{ path: string; message: string }> {
  const issues: ValidationIssue[] = []
  const segments = buildSegments(recipe)

  validateSegmentBoundaries(recipe, segments, issues)
  validateVariableReferences(recipe, segments, issues)
  issues.push(...validateProviderActions(recipe))

  return issues
}

export function validateRecipe(recipe: Recipe): void {
  const issues = validateRecipeCollectIssues(recipe)

  if (issues.length > 0) {
    throw new RecipeValidationError(
      `Recipe validation failed with ${issues.length} issue(s)`,
      issues,
    )
  }
}
