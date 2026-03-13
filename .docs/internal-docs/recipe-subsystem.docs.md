# Recipe Subsystem Architecture

The recipe subsystem is a multi-step analysis pipeline engine that parses YAML-defined recipes, validates them, segments execution around agent (LLM) breakpoints, and executes API calls with template variable resolution, rate limiting, pagination, and data transforms. The system supports a "yield-and-resume" pattern where execution pauses at agent steps and can be resumed with external input across separate CLI invocations.

## Relevant Files

- `/Users/j/dev/aixbt/cli/src/types.ts`: All type definitions -- Recipe, RecipeStep (union of ApiStep | ForeachStep | AgentStep | TransformStep), ExecutionContext, Segment, StepResult, TransformBlock, SampleTransform, output types (RecipeAwaitingAgent, RecipeComplete), type guards
- `/Users/j/dev/aixbt/cli/src/commands/recipe.ts`: CLI command handlers for `list`, `info`, `clone`, `validate`, `run` -- orchestrates parsing, validation, execution, and output formatting
- `/Users/j/dev/aixbt/cli/src/lib/recipe-parser.ts`: YAML parsing and structural validation (parseRecipe) -- converts raw YAML to typed Recipe objects, validates every field with issue collection
- `/Users/j/dev/aixbt/cli/src/lib/recipe-validator.ts`: Semantic validation -- segment boundary checking, variable reference validation (cross-segment access, undefined params, unknown steps), template ref extraction
- `/Users/j/dev/aixbt/cli/src/lib/recipe-engine.ts`: Execution engine -- template resolution (resolveValue, resolveExpression, resolveEndpoint), relative time, foreach with adaptive concurrency, pagination, step execution, segment traversal, resume flow, output assembly
- `/Users/j/dev/aixbt/cli/src/lib/transforms.ts`: Data transform implementations -- applySelect (field projection with nested path support), applySample (weighted sampling with guarantee fraction, maxTokens budget, recency/strength default weighting)
- `/Users/j/dev/aixbt/cli/src/lib/registry.ts`: Registry client -- fetches recipe list and detail from `/v2/cli/recipes` (unauthenticated)
- `/Users/j/dev/aixbt/cli/src/lib/api-client.ts`: HTTP client with retry backoff, rate limit header parsing, error classification
- `/Users/j/dev/aixbt/cli/src/lib/errors.ts`: Error hierarchy -- CliError base, RecipeValidationError (with issues array), ApiError, RateLimitError, etc.
- `/Users/j/dev/aixbt/cli/tests/lib/recipe-engine.test.ts`: ~1900 lines, thorough coverage of resolveValue, resolveEndpoint, resolveRelativeTime, executeRecipe (core flow, resume, foreach, pagination, transforms, output)
- `/Users/j/dev/aixbt/cli/tests/lib/recipe-parser.test.ts`: ~1350 lines, covers all step types, field validation, issue collection, transform blocks, YAML syntax errors
- `/Users/j/dev/aixbt/cli/tests/lib/recipe-validator.test.ts`: ~690 lines, covers segment building, boundary validation, variable references, transform step validation
- `/Users/j/dev/aixbt/cli/tests/lib/transforms.test.ts`: ~310 lines, covers select projection, sample with count/maxTokens/guarantee/weight_by, ordering preservation
- `/Users/j/dev/aixbt/cli/tests/commands/recipe.test.ts`: ~900 lines, integration tests with mocked fetch for list/validate/run/info/clone commands

## Architectural Patterns

### 1. Pipeline Data Flow (YAML -> Parse -> Validate -> Segment -> Execute -> Output)

The flow is strictly linear:
1. `parseRecipe()` converts YAML string to typed `Recipe` object, performing structural validation
2. `validateRecipe()` performs semantic validation (segment boundaries, variable references)
3. `buildSegments()` splits the step array into segments divided by agent steps
4. `executeRecipe()` iterates segments, executing steps sequentially within each segment
5. Output is either `RecipeAwaitingAgent` (paused at agent step) or `RecipeComplete` (all done)

### 2. Four Step Types (Discriminated Union)

Steps are a union type discriminated by property presence rather than a single `type` field:
- **ApiStep**: Has `endpoint`, no `foreach`/`input`/`type`
- **ForeachStep**: Has `foreach` + `endpoint`
- **AgentStep**: Has `type: 'agent'` (the only one using an explicit type discriminator)
- **TransformStep**: Has `input` + `transform`, no `endpoint`

Type guards (`isAgentStep`, `isForeachStep`, `isTransformStep`, `isApiStep`) use property presence checks. The `never` types on mutually exclusive fields provide compile-time safety.

### 3. Segmentation Strategy (Agent Steps as Execution Boundaries)

`buildSegments()` in `recipe-validator.ts` splits the step array by agent steps. The agent step itself is included at the **end** of the segment it terminates (not the beginning of the next). The following segment gets a `precedingAgentStep` reference.

Segment structure for `[api1, agent1, api2, agent2, api3]`:
- Segment 0: `[api1, agent1]`, precedingAgentStep: undefined
- Segment 1: `[api2, agent2]`, precedingAgentStep: agent1
- Segment 2: `[api3]`, precedingAgentStep: agent2

When the engine hits an agent step during iteration, it immediately returns `RecipeAwaitingAgent` -- it does not execute the agent step itself. On resume, the agent's output is injected as a StepResult for that agent step's id.

### 4. Template/Variable Resolution System

Template syntax: `{expression}` where expression can be:
- `params.X` -- recipe parameter
- `item` / `item.X` -- foreach iteration item
- `step_id` / `step_id.data` -- full step result data
- `step_id.data.nested.path` -- nested field access
- `step_id.data[*].field` -- pluck operation (map over array)

Two modes in `resolveString()`:
- **Single expression** (`{expr}` is the entire string): preserves original type (array, object, number)
- **Mixed interpolation** (`text {expr} text`): always coerces to string via `String()`

`resolveValue()` recursively resolves strings, arrays, and objects. Non-string primitives pass through unchanged.

Relative time expressions (`-24h`, `-7d`, `-30m`) are resolved to ISO timestamps before template processing.

### 5. Rate Limiting and Pagination

**Pagination**: Triggered when a step's resolved `limit` param exceeds `MAX_PAGE_LIMIT` (50). `paginateApiStep()` fetches pages sequentially, adding `page` and `limit` query params, accumulating results until `hasMore` is false or target count is reached.

**Rate limiting in foreach**: `deriveConcurrency()` adjusts batch size based on `remainingPerMinute`:
- <=5 remaining: concurrency 1
- <=20: concurrency 3
- <=50: concurrency 5
- >50: concurrency 10

`waitIfRateLimited()` pauses when remaining <= 2. Wait time comes from `retryAfterSeconds` header or calculates from `resetMinute` timestamp.

**Rate limiting in api-client**: `executeWithBackoff()` retries 429 responses up to 3 times with sleep based on retry-after header.

### 6. Transform System

Two transform operations:
- **select**: Field projection -- picks specified fields from each item, supports dot-notation paths with `setNestedValue()` for output reconstruction
- **sample**: Weighted random sampling -- `applySample()` uses a guarantee fraction (default 0.3) to deterministically include top-weighted items, then weighted random sampling for remaining slots. Default weighting is `recency * activity_length`, using `detectedAt`/`date`/`createdAt` for recency and `activity.length` for strength.

Execution order: sample runs **before** select (intentional -- weight fields must be available during sampling).

Transform steps (`input` + `transform`) are pure data transforms with no API calls. Inline `transform` blocks on API/foreach steps apply post-fetch.

### 7. Yield-and-Resume Pattern

The recipe engine supports multi-invocation execution:
1. First invocation runs until first agent step, returns `RecipeAwaitingAgent` with context data and a `resumeCommand` string
2. External agent (LLM) processes the data and produces output matching the `returns` schema
3. Second invocation uses `--resume-from step:<id>` + `--input '<json>'` to inject agent output and continue
4. `findResumeSegment()` locates the correct segment, `validateResumeInput()` checks field presence and array types
5. Agent output is stored as a StepResult, subsequent steps can reference it

This can chain through multiple agent steps in a recipe (N agent steps = N+1 invocations).

### 8. Validation Architecture (Two-Phase, Issue Collection)

Phase 1 (Parser): `parseRecipe()` validates structure -- field types, required fields, duplicate ids, transform block shapes. Collects all issues, throws `RecipeValidationError` with full issue list.

Phase 2 (Validator): `validateRecipeCollectIssues()` performs semantic checks:
- `validateSegmentBoundaries()`: ensures steps only reference accessible results within their segment (no cross-boundary references except the preceding agent step)
- `validateVariableReferences()`: checks template refs against defined params and step ids, checks foreach references, checks endpoint templates, validates transform step input ordering

Both phases collect ALL issues before reporting (not fail-fast).

## Gotchas and Edge Cases

- **Step type detection is property-based, not type-based**: Only AgentStep uses `type: 'agent'`. TransformStep is detected by `input` presence, ForeachStep by `foreach` presence. A step with both `input` and `foreach` is caught at parse time but could theoretically confuse guards if validation is bypassed.

- **`isApiStep` is a negative check**: It returns true only when all other guards return false. Any new step type would be misclassified as an API step if its guard is not added.

- **Agent step at position 0 is a valid but odd pattern**: The segmenter handles it (creates a segment with just the agent step), but it means the first segment produces only `RecipeAwaitingAgent` with no data -- the agent gets no context.

- **TEMPLATE_REGEX has global flag and is shared**: `TEMPLATE_REGEX = /\{([^}]+)\}/g` is exported from types.ts. `extractTemplateRefs` in the validator creates a new RegExp from the source+flags to avoid lastIndex issues. `resolveString` uses `str.replace(TEMPLATE_REGEX, ...)` which is safe because `String.prototype.replace` resets lastIndex. However, any future code that uses `TEMPLATE_REGEX.exec()` directly would need to be careful about the shared global state.

- **Relative time resolution happens outside template processing**: In `resolveString()`, the raw string is checked against `RELATIVE_TIME_REGEX` before template resolution. A string like `-24h` is converted to an ISO timestamp. This means `-24h` cannot be a literal param value -- it will always be converted.

- **Foreach error handling is lenient**: Failed items are silently collected into a `failures` array on the ForeachResult, but the failures are NOT included in the final `RecipeComplete.data` output. Only `successItems` are stored. The failures data is lost at the `buildCompleteOutput` boundary because `ctx.results.set()` stores the full ForeachResult, but `data[stepId] = result.data` only takes the `.data` field.

- **Pagination only applies when resolved `limit > MAX_PAGE_LIMIT`**: If limit is exactly 50 or below, no pagination occurs. The pagination logic always sets `page` and `limit` as query params, which assumes the API supports these param names.

- **`executeStep` handles AgentStep endpoint resolution with empty string**: Line 603-604 in recipe-engine.ts passes empty string to `resolveEndpoint` for agent steps, but agent steps never reach this code path because they are caught earlier by `isAgentStep(step)` returning early in the segment loop. However, if they did, resolving an empty endpoint would produce `{ method: 'GET', path: '' }`.

- **Resume doesn't re-execute prior segments**: When resuming from an agent step, the engine starts at the segment after the agent. Prior step results are NOT available -- only the agent's injected output. Steps in the post-resume segment cannot reference any step from before the agent boundary (enforced by validation).

- **`buildCompleteOutput` with `outputDir` names files by iteration order, not step id**: Files are named `segment-001.json`, `segment-002.json` based on Map iteration order of `ctx.results`. This could be confusing if steps execute out of visual order.

- **Token estimation is rough**: `estimateTokenCount` uses `JSON.stringify(data).length / 4`, which is a byte-length heuristic. The `maxTokens` sampling in `resolveTargetCount` uses the same heuristic. For non-English or heavily nested JSON, this could significantly misestimate.

- **Default weighting uses `1 / (age + 1)` for recency**: The `+1` prevents division by zero but means items with identical timestamps get weight 1/(0+1) = 1 instead of infinity. For items with no date field, recency weight is 1.

- **`flattenParams` joins arrays with commas**: Any array-valued param gets `val.join(',')`. This is an implicit convention that the API expects comma-separated values for array parameters.

- **The recipe parser returns steps even when issues are found**: `validateStep` returns null for fundamentally broken steps (missing id, not an object), but returns partially-constructed step objects when individual fields are invalid (e.g., agent step missing `context` returns a step with `context: []`). The recipe is only thrown as invalid if `issues.length > 0` at the end of `parseRecipe`.

- **`extractDynamicParams` in recipe.ts uses a naive parser**: It matches `--key value` pairs from `cmd.args`, skipping values that start with `--`. This means boolean flags would be consumed as keys with the next arg as value, and values starting with `--` would be treated as keys.

## Code Quality Observations

### Well-Designed Areas

- **Issue collection pattern**: Both parser and validator collect all issues before throwing, providing comprehensive error reporting in a single pass. The `ValidationIssue` type and `RecipeValidationError` propagate structured errors cleanly.

- **Segment boundary validation**: The validator correctly tracks accessible step ids per segment, preventing cross-boundary references that would fail at runtime. The error messages include the list of accessible steps, which is excellent for debugging.

- **Type preservation in template resolution**: The single-expression vs mixed-interpolation distinction in `resolveString()` is well-thought-out -- `{step.data}` preserves arrays/objects while `prefix {step.data}` coerces to string. This is critical for passing structured data between steps.

- **Test coverage is strong**: ~5000+ lines of tests across 5 test files. The engine tests cover core flow, resume, foreach, pagination, transforms, and edge cases. Tests use proper helpers and well-structured describe blocks.

- **Graceful degradation**: `buildCompleteOutput` falls back to inline data when file writes fail. Foreach captures individual failures without aborting the entire step.

### Areas for Improvement

- **recipe-engine.ts is 839 lines and does too much**: It contains template resolution, relative time, param flattening, rate limit tracking, foreach execution, pagination, step execution, token estimation, output building, resume logic, and the top-level executeRecipe. This would benefit from decomposition -- the template resolution, foreach execution, and pagination logic could each be separate modules.

- **No support for POST/PUT body**: `resolveEndpoint` parses method from the endpoint string, but the API client only calls `get()`. Recipes cannot make POST requests despite the endpoint format supporting `POST /path`.

- **Foreach failures are silently dropped from output**: The `ForeachResult` type includes a `failures` array, but `buildCompleteOutput` only includes `result.data` (which is `successItems`). Users have no visibility into partial failures unless they instrument the code.

- **The `computeWeights` default weighting is domain-specific**: It looks for `detectedAt`/`date`/`createdAt` and `activity` fields, which are specific to the AIXBT signal data model. This works for the current use case but would surprise users with different data shapes. The weight would silently be 1 for any item without these fields.

- **`buildAwaitingAgentOutput` resume command construction is fragile**: It concatenates shell strings with manual escaping of single quotes. This could break with unusual param values containing other special shell characters (backticks, $, etc.).

- **No timeout on recipe execution**: A recipe with many foreach items or large pagination could run indefinitely. There is no overall timeout or cancellation mechanism.

- **Transform step has no `type` discriminator in the YAML**: While API steps also lack one, the transform step is detected purely by `input` field presence. Adding `type: 'transform'` would make the YAML more self-documenting and the parser more robust.

- **Test file has a stale `prompt` field**: In `recipe-parser.test.ts` line 1269, the AgentStep test fixture uses `prompt: 'Analysis step'` instead of `instructions`, suggesting a field rename that was not fully propagated to test fixtures. This test still passes because the type guard only checks `type === 'agent'`, but the fixture does not match the actual AgentStep interface.

## Other Docs

- CLI recipe documentation: https://docs.aixbt.tech/builders/cli/recipes
- Error hierarchy: `/Users/j/dev/aixbt/cli/src/lib/errors.ts`
- API client internals: `/Users/j/dev/aixbt/cli/src/lib/api-client.ts`
