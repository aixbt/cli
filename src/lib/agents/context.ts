/**
 * Action-based context blocks injected into agent prompts.
 *
 * Each block provides ~50 tokens of domain context for a specific
 * AIXBT data type. The engine resolves which blocks to inject by
 * scanning the recipe's step actions.
 */

import type { RecipeStep, StepResult } from '../../types.js'

/** Context keyed by AIXBT action name. */
const ACTION_CONTEXT: Record<string, string> = {
  signals: [
    'Signals: Each signal has detectedAt (first sighting) and reinforcedAt (latest confirmation).',
    'When multiple independent detections report the same event, they reinforce one signal rather than creating duplicates.',
    'The activity array length is the total detection count: 1 means a single detection with no reinforcement.',
    'Signal descriptions evolve over time: initial detections may be incomplete, underlying facts or metrics can change as events unfold, or early reports may be corrected.',
    'hasOfficialSource means the project\'s own official account appears in the signal\'s activity.',
  ].join(' '),

  projects: [
    'Projects: momentumScore measures rate of change in cluster attention (how quickly new clusters pick up a project).',
    'popularityScore measures sustained mention volume over time.',
    'High momentum with low popularity = emerging project gaining traction. High popularity with declining momentum = established but cooling off.',
    'createdAt is when AIXBT started tracking the project, not when the project itself launched.',
  ].join(' '),

  momentum: [
    'Momentum: The score measures how quickly new clusters pick up a project.',
    'A project discussed across 5 clusters scores higher than one with more total mentions from 2 clusters.',
    'Cluster convergence often surfaces before broader market recognition.',
    'Patterns: expanding (new clusters joining), sustained (stable), contracting (fading), spike (sharp rise then decline).',
  ].join(' '),

  clusters: [
    'Clusters: Each cluster is a distinct community segment identified via social graph analysis of follow relationships on X.',
    'When multiple unconnected clusters independently discuss the same project (convergence), it carries greater weight than high volume from a single cluster.',
  ].join(' '),
}

/** Context triggered by specific fields in the step's transform.select array. */
const SELECT_CONTEXT: Record<string, { action: string; text: string }> = {
  activity: {
    action: 'signals',
    text: [
      'Activity: Each entry in the activity array is itself a detected signal that was merged into this one, not a raw source like a tweet.',
      'The incoming field is the new detection\'s description; result is the signal description after merging.',
      'An isOfficial entry means the project\'s own account produced that detection. If it is the first or only entry, the official source originated the signal; later isOfficial entries are corroboration.',
    ].join(' '),
  },
}

/**
 * Scan recipe steps and return applicable context blocks.
 * When step results are provided, includes specific sampling counts.
 */
export function resolveContextHints(
  steps: RecipeStep[],
  results?: Map<string, StepResult>,
): string[] {
  const seen = new Set<string>()
  const hints: string[] = []
  const samplingNotes: string[] = []

  for (const step of steps) {
    if (!('action' in step) || typeof step.action !== 'string') continue

    const source = 'source' in step ? step.source : undefined
    // Only inject for AIXBT actions (no source or source === 'aixbt')
    const key = (!source || source === 'aixbt') ? step.action : null
    if (key && ACTION_CONTEXT[key] && !seen.has(key)) {
      seen.add(key)
      hints.push(ACTION_CONTEXT[key])
    }

    // Check for field-specific context: present if explicitly selected OR no select filter
    const transform = 'transform' in step ? step.transform : undefined
    const select = (transform as { select?: string[] } | undefined)?.select
    if (key) {
      for (const [field, entry] of Object.entries(SELECT_CONTEXT)) {
        if (entry.action !== key || seen.has(`${key}:${field}`)) continue
        if (!select || select.includes(field)) {
          seen.add(`${key}:${field}`)
          hints.push(entry.text)
        }
      }
    }

    // Collect specific sampling notes from step results
    const result = results?.get(step.id)
    if (result?.sampled) {
      samplingNotes.push(
        `The "${step.id}" data was sampled to ${result.sampled.after} of ${result.sampled.before} total items, weighted by ${result.sampled.weightedBy}.`,
      )
    } else if (transform && 'sample' in transform && transform.sample && !result) {
      // Fallback: step has sampling but no result metadata (e.g. foreach steps)
      const weightedBy = (transform.sample as { weight_by?: string }).weight_by ?? 'recency and reinforcement count'
      samplingNotes.push(
        `The "${step.id}" data was sampled (weighted by ${weightedBy}) and may not include all items.`,
      )
    }
  }

  if (samplingNotes.length > 0) {
    const weightExplanation = 'The default weighting favors recent items and those with more reinforcements (activity entries), so older or single-detection items are less likely to appear.'
    hints.push(
      `Sampling: ${samplingNotes.join(' ')} ${weightExplanation} Do not draw conclusions about total counts from the number of items present.`,
    )
  }

  return hints
}
