import chalk from 'chalk'
import ora from 'ora'
import type { Ora } from 'ora'
import { encode } from '@toon-format/toon'
import type { ActivityEntry, FreeTierMeta } from '../types.js'

/** Cached update info, set by cli.ts at startup. */
let _updateInfo: { current: string; latest: string; type: string } | undefined
export function setUpdateInfo(info: typeof _updateInfo): void { _updateInfo = info }
export function getUpdateInfo(): typeof _updateInfo { return _updateInfo }

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function visibleLength(s: string): number {
  return stripAnsi(s).length
}

function padEndVisible(s: string, width: number): string {
  const pad = width - visibleLength(s)
  return pad > 0 ? s + ' '.repeat(pad) : s
}

function padStartVisible(s: string, width: number): string {
  const pad = width - visibleLength(s)
  return pad > 0 ? ' '.repeat(pad) + s : s
}

export type OutputFormat = 'human' | 'json' | 'toon'
export type StructuredFormat = 'json' | 'toon'

/** Returns true for formats that produce structured (machine-readable) output. */
export function isStructuredFormat(format: OutputFormat): format is StructuredFormat {
  return format !== 'human'
}

// -- Brand --

const BRAND_HEX = '#b07de3'  // AIXBT brand purple
const brandColor = chalk.hex(BRAND_HEX)
const brandBold = brandColor.bold

// -- Banner --

const BYLINES = [
  'Sidelined?',
  'Trenches never sleep',
  'Buy high sell higher',
  'Believe in something',
  'Still early',
]

const ASCII_ART = [
  '    █████████   █████ █████ █████ ███████████  ███████████',
  '   ███░░░░░███ ░░███ ░░███ ░░███ ░░███░░░░░███░█░░░███░░░█',
  '  ░███    ░███  ░███  ░░███ ███   ░███    ░███░   ░███  ░ ',
  '  ░███████████  ░███   ░░█████    ░██████████     ░███    ',
  '  ░███░░░░░███  ░███    ███░███   ░███░░░░░███    ░███    ',
  '  ░███    ░███  ░███   ███ ░░███  ░███    ░███    ░███    ',
  '  █████   █████ █████ █████ █████ ███████████     █████   ',
  ' ░░░░░   ░░░░░ ░░░░░ ░░░░░ ░░░░░ ░░░░░░░░░░░     ░░░░░    ',
]

export function banner(version: string): string {
  const byline = BYLINES[Math.floor(Math.random() * BYLINES.length)]
  const artWidth = 58 // visual width of the widest art line
  const pad = Math.max(0, Math.floor((artWidth - byline.length) / 2))
  const lastSolid = ASCII_ART.length - 2
  return [
    '',
    ...ASCII_ART.map((line, i) => i === lastSolid
      ? chalk.white(line.trimEnd()) + `  ${chalk.dim(`v${version}`)}`
      : chalk.white(line)),
    '',
    ' '.repeat(pad) + chalk.cyan(byline),
    '',
  ].join('\n')
}

// -- String formatters (return strings, do not log) --

export const fmt = {
  brand: brandColor,
  brandBold: brandBold,
  dim: chalk.dim,
  green: chalk.green,
  red: chalk.red,
  yellow: chalk.yellow,
  magenta: chalk.magenta,
  blue: chalk.hex('#87ceeb'),
  tag: (text: string, bg = '#888888') => chalk.bgHex(bg).hex('#1a1a1a')(text),
  boldWhite: chalk.bold.white,
  cyan: chalk.cyan,
  // Semantic aliases
  id: chalk.magenta,
  address: chalk.magenta,
  number: chalk.yellow,
  link: (url: string, text?: string) => {
    const display = brandColor(text ?? url)
    return `\x1b]8;;${url}\x07${display}\x1b]8;;\x07`
  },
}

// -- Cluster dot colors (muted palette) --
// chalk.hex auto-downgrades to 256/16 based on chalk.level.
// For basic 16-color terminals, hex muted tones all map to white,
// so we use distinct standard colors as fallback.

const CLUSTER_DOT_COLORS = chalk.level >= 2
  ? [
    chalk.hex('#6bcf8a'),  // sage green
    chalk.hex('#6bb8cf'),  // dusty cyan
    chalk.hex('#cf6b9e'),  // muted rose
    chalk.hex('#cf9f6b'),  // warm tan
    chalk.hex('#9b7ec8'),  // soft purple
    chalk.hex('#6bcfb5'),  // seafoam
    chalk.hex('#c86b8a'),  // dusty pink
    chalk.hex('#6ba3cf'),  // steel blue
    chalk.hex('#c8b86b'),  // muted gold
    chalk.hex('#8ac8b8'),  // pale teal
  ]
  : [
    chalk.green,
    chalk.cyan,
    chalk.magenta,
    chalk.yellow,
    chalk.blue,
    chalk.greenBright,
    chalk.cyanBright,
    chalk.magentaBright,
    chalk.yellowBright,
    chalk.redBright,
  ]

const OFFICIAL_DOT = chalk.hex('#87ceeb')('●')

export function clusterDot(index: number, name?: string): string {
  if (name?.toLowerCase() === 'official channels') return OFFICIAL_DOT
  const color = CLUSTER_DOT_COLORS[index % CLUSTER_DOT_COLORS.length]
  return color('●')
}

/**
 * Format signal activity entries as display lines (newest first, clusters accumulate chronologically).
 * Returns an array of multi-line strings, one per activity entry.
 */
export function formatActivity(
  activity: ActivityEntry[],
  clusterColorMap: Map<string, number>,
  opts?: { width?: number },
): string[] {
  const indent = '  '
  const cols = opts?.width ?? (process.stdout.columns || 80)
  // Build cluster snapshots chronologically (activity is oldest-first)
  const clusterSnapshots: Set<string>[] = []
  const seen = new Set<string>()
  for (const a of activity) {
    if (a.cluster) seen.add(a.cluster.id)
    clusterSnapshots.push(new Set(seen))
  }
  const reversed = [...activity].reverse()
  return reversed.map((a, idx) => {
    const isFirst = idx === reversed.length - 1
    const lines: string[] = []
    const officialBadge = a.isOfficial ? ` ${fmt.tag('OFFICIAL', '#87ceeb')}` : ''
    if (a.date) lines.push(`${indent}${fmt.dim(timeAgo(a.date))}${officialBadge}`)
    lines.push(`${indent}${fmt.brand('→ incoming:')} ${wrapIndented(fmt.dim(a.incoming), indent, 15, cols)}`)
    if (isFirst) {
      lines.push(`${indent}${fmt.green('↳ SIGNAL CREATED')}`)
    } else if (a.result) {
      lines.push(`${indent}${fmt.green('↳ result:')} ${wrapIndented(fmt.dim(a.result), indent, 13, cols)}`)
    }
    const chronoIdx = activity.length - 1 - idx
    const snapshot = clusterSnapshots[chronoIdx]
    if (snapshot.size > 0) {
      const dots = [...snapshot].map(id => {
        const name = activity.find(x => x.cluster?.id === id)?.cluster?.name ?? ''
        return `${clusterDot(clusterColorMap.get(id) ?? 0, name)} ${fmt.dim(name)}`
      }).join('  ')
      lines.push(`${indent}${dots}`)
    }
    return lines.join('\n')
  })
}

// -- Time formatting --

export function timeAgo(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  if (isNaN(then)) return dateStr

  const seconds = Math.floor((now - then) / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(days / 365)
  return `${years}y ago`
}

// -- Inquirer theme --

export const aixbtTheme = {
  prefix: brandColor('›'),
  style: {
    highlight: brandBold,
    answer: brandColor,
  },
}

// -- Logging helpers (write to stdout/stderr) --

export function success(msg: string): void {
  console.log(chalk.green(`OK ${msg}`))
}

export function error(msg: string): void {
  console.error(chalk.red(`error: ${msg}`))
}

export function warn(msg: string): void {
  console.error(chalk.yellow(`warn: ${msg}`))
}

export function info(msg: string): void {
  console.log(brandColor(msg))
}

export function dim(msg: string): void {
  console.log(chalk.dim(msg))
}

export function delayedDataWarning(meta: FreeTierMeta): void {
  console.log()
  console.log(`${chalk.yellow('Delayed data')} ${fmt.dim(`(${meta.dataDelayHours}h delay)`)} ${fmt.dim('·')} ${fmt.dim('For real-time data:')} aixbt login`)
}

export function hint(msg: string): void {
  console.log()
  console.log(chalk.dim(msg))
}

/** Print multiple hints as dim footer lines. */
export function printHints(hints: string[]): void {
  for (const h of hints) {
    hint(h)
  }
}

export function label(key: string, value: string): void {
  console.log(`${chalk.bold.white(key + ':')}  ${value}`)
}

export function keyValue(key: string, value: string, pad = 18, opts?: { noColon?: boolean; keyStyle?: (s: string) => string; fill?: boolean }): void {
  const padding = Math.max(0, pad - key.length)
  const suffix = opts?.noColon ? ' ' : ':'
  const style = opts?.keyStyle ?? chalk.dim
  const gap = opts?.fill ? chalk.dim('─'.repeat(padding) + ' ') : ' '.repeat(padding) + ' '
  const prefix = `  ${style(key + suffix)}${gap}`
  const indent = 2 + key.length + 1 + padding + 1
  const continuation = ' '.repeat(indent)
  const termWidth = getTerminalWidth()
  const valueWidth = termWidth - indent

  // Handle explicit newlines (e.g. multi-value fields like tokens)
  if (value.includes('\n')) {
    const parts = value.split('\n')
    let isFirst = true
    for (const part of parts) {
      if (part === '') {
        console.log()
        continue
      }
      // Preserve leading whitespace on wrapped continuation lines
      const plainPart = stripAnsi(part)
      const leadMatch = plainPart.match(/^(\s+)/)
      const lead = leadMatch ? leadMatch[1] : ''
      const innerWidth = valueWidth - lead.length
      const inner = lead.length > 0 ? part.slice(lead.length) : part
      const wrapped = innerWidth > 20 ? wrapText(inner, innerWidth) : [inner]
      for (const chunk of wrapped) {
        const line = `${lead}${chunk}`
        console.log(isFirst ? `${prefix}${line}` : `${continuation}${line}`)
        isFirst = false
      }
    }
    return
  }

  if (valueWidth <= 20 || visibleLength(value) <= valueWidth) {
    console.log(`${prefix}${value}`)
    return
  }

  const lines = wrapText(value, valueWidth)

  for (let i = 0; i < lines.length; i++) {
    console.log(i === 0 ? `${prefix}${lines[i]}` : `${continuation}${lines[i]}`)
  }
}

export function spinner(text: string): Ora {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'].map(f => brandColor(f))
  return ora({ text, spinner: { interval: 80, frames } }).start()
}

export async function withSpinner<T>(
  text: string,
  outputFormat: OutputFormat,
  fn: () => Promise<T>,
  failText?: string,
  opts?: { silent?: boolean },
): Promise<T> {
  const spin = isStructuredFormat(outputFormat) ? null : spinner(text)
  try {
    const result = await fn()
    if (opts?.silent) {
      spin?.stop()
    } else {
      spin?.succeed()
    }
    return result
  } catch (err) {
    spin?.fail(failText ?? text)
    throw err
  }
}

// -- API key masking --

export function maskApiKey(key: string): string {
  if (key.length <= 8) return '****'
  return key.slice(0, 6) + '...' + key.slice(-4)
}

// -- Table formatter --

interface TableColumn {
  key: string
  header: string
  width?: number
  align?: 'left' | 'right'
  format?: (value: unknown) => string
}

export type { TableColumn }

export function getTerminalWidth(): number {
  return process.stdout.columns || 80
}

function distributeWidths(
  columns: TableColumn[],
  contentWidths: number[],
  available: number,
): number[] {
  const totalContent = contentWidths.reduce((sum, w) => sum + w, 0)

  if (totalContent <= available) {
    return contentWidths
  }

  const minWidths = columns.map((col, i) => {
    const min = col.width
      ? Math.min(col.width, Math.floor(available / 2))
      : Math.min(contentWidths[i], Math.floor(available / columns.length))
    return min
  })

  const totalMin = minWidths.reduce((sum, w) => sum + w, 0)
  const remaining = Math.max(0, available - totalMin)

  const totalWanted = contentWidths.reduce(
    (sum, w, i) => sum + Math.max(0, w - minWidths[i]),
    0,
  )

  return minWidths.map((min, i) => {
    if (totalWanted === 0) return min
    const wanted = Math.max(0, contentWidths[i] - min)
    const bonus = Math.floor((wanted / totalWanted) * remaining)
    return min + bonus
  })
}

/**
 * Build a map from plain-text index to styled-text index.
 * map[i] = the index in the styled string where plain character i starts.
 */
function buildCharMap(styled: string): number[] {
  const map: number[] = []
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[[0-9;]*m/g
  for (let i = 0; i < styled.length;) {
    re.lastIndex = i
    const m = re.exec(styled)
    if (m && m.index === i) {
      i += m[0].length
    } else {
      map.push(i)
      i++
    }
  }
  return map
}

/**
 * Slice a styled string by plain-text offsets, preserving all ANSI codes.
 * Includes any ANSI codes that appear before/within the slice range.
 */
function styledSlice(styled: string, map: number[], start: number, end: number): string {
  if (map.length === 0) return ''
  // Find the styled index for the start — include any leading ANSI codes
  let sStart = start === 0 ? 0 : map[start]
  // Walk backwards from sStart to include any ANSI codes just before this char
  if (start > 0) {
    while (sStart > 0 && styled[sStart - 1] === 'm') {
      const codeStart = styled.lastIndexOf('\x1b', sStart - 1)
      if (codeStart >= 0 && codeStart >= (map[start - 1] ?? 0) + 1) {
        sStart = codeStart
      } else {
        break
      }
    }
  }
  const sEnd = end >= map.length ? styled.length : map[end]
  return styled.slice(sStart, sEnd)
}

export function wrapText(text: string, width: number): string[] {
  if (width <= 0) return [text]
  if (visibleLength(text) <= width) return [text]

  const plain = stripAnsi(text)
  if (plain.length <= width) return [text]

  // Find word-wrap break positions in plain text
  const breaks: number[] = [0]
  let remaining = plain
  let pos = 0

  while (remaining.length > 0) {
    if (remaining.length <= width) {
      breaks.push(pos + remaining.length)
      break
    }

    let breakAt = remaining.lastIndexOf(' ', width)
    if (breakAt <= 0) breakAt = width

    const chunk = remaining.slice(0, breakAt)
    pos += chunk.length
    breaks.push(pos)
    const rest = remaining.slice(breakAt)
    const trimmed = rest.trimStart()
    pos += rest.length - trimmed.length
    remaining = trimmed
  }

  // No ANSI? Just slice plain text
  const hasAnsi = ANSI_RE.test(text)
  ANSI_RE.lastIndex = 0
  if (!hasAnsi) {
    const lines: string[] = []
    for (let i = 0; i < breaks.length - 1; i++) {
      lines.push(plain.slice(breaks[i], breaks[i + 1]).trim())
    }
    return lines.length > 0 ? lines : ['']
  }

  // Slice the styled text using the char map
  const map = buildCharMap(text)
  const lines: string[] = []
  for (let i = 0; i < breaks.length - 1; i++) {
    const start = breaks[i]
    // Skip leading whitespace for continuation lines
    let adjStart = start
    if (i > 0) {
      while (adjStart < plain.length && plain[adjStart] === ' ') adjStart++
    }
    const end = breaks[i + 1]
    const slice = styledSlice(text, map, adjStart, end).trim()
    if (slice) lines.push(slice)
  }

  return lines.length > 0 ? lines : ['']
}

/**
 * Wrap text to terminal width, indenting continuation lines.
 * @param text - the text to wrap
 * @param indent - prefix string for continuation lines
 * @param prefixWidth - visible width already consumed on the first line (e.g. "  → incoming: ")
 */
export function wrapIndented(text: string, indent: string, prefixWidth: number, cols?: number): string {
  cols = cols ?? (process.stdout.columns || 80)
  const contWidth = cols - visibleLength(indent)
  const firstWidth = cols - prefixWidth
  if (firstWidth <= 0) return text

  // Wrap first line at the tighter width, then continuation lines at indent width
  const firstLines = wrapText(text, firstWidth)
  if (firstLines.length <= 1) return firstLines[0] ?? text
  const result = [firstLines[0]]
  const rest = firstLines.slice(1).join(' ')
  for (const line of wrapText(rest, contWidth)) {
    result.push(`${indent}${line}`)
  }
  return result.join('\n')
}

export function table<T extends Record<string, unknown>>(
  data: T[],
  columns: TableColumn[],
): void {
  if (data.length === 0) {
    dim('No results.')
    return
  }

  const termWidth = getTerminalWidth()

  const contentWidths = columns.map(col => {
    const headerLen = col.header.length
    const maxDataLen = data.reduce((max, row) => {
      const val = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')
      return Math.max(max, visibleLength(val))
    }, 0)
    const natural = Math.max(headerLen, maxDataLen) + 2
    return col.width ? Math.max(natural, col.width) : natural
  })

  const gutterWidth = (columns.length - 1) * 2
  const available = termWidth - gutterWidth

  const widths = distributeWidths(columns, contentWidths, available)

  const headerLine = columns
    .map((col, i) => chalk.dim(col.align === 'right' ? col.header.padStart(widths[i]) : col.header.padEnd(widths[i])))
    .join('  ')
  console.log(headerLine)
  console.log(chalk.dim('─'.repeat(Math.min(visibleLength(headerLine), termWidth))))

  for (const row of data) {
    const cellValues = columns.map((col, i) => {
      const raw = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')
      return wrapText(raw, widths[i])
    })

    const maxLines = Math.max(...cellValues.map(v => v.length))

    for (let line = 0; line < maxLines; line++) {
      const rowLine = columns.map((col, i) => {
        const text = cellValues[i][line] ?? ''
        return col.align === 'right'
          ? padStartVisible(text, widths[i])
          : padEndVisible(text, widths[i])
      }).join('  ')
      console.log(rowLine)
    }
  }
}

// -- Card layout --

export interface CardField {
  label: string
  value: string | undefined | null
  section?: boolean
  noColon?: boolean
  keyStyle?: (s: string) => string
  fill?: boolean
}

export interface CardItem {
  title: string
  subtitle?: string
  badge?: string
  fields: CardField[]
}

export function cards(items: CardItem[], opts?: { pad?: number }): void {
  if (items.length === 0) {
    dim('No results.')
    return
  }

  const pad = opts?.pad ?? 18

  for (let i = 0; i < items.length; i++) {
    const item = items[i]

    // Title line
    const badgePart = item.badge ? `${item.badge} ` : ''
    const subtitlePart = item.subtitle ? `  ${item.subtitle}` : ''
    console.log(`${badgePart}${chalk.bold.white(item.title)}${subtitlePart}`)

    // Fields
    for (const field of item.fields) {
      if (field.section) {
        const valuePart = field.value ? `  ${chalk.dim(field.value)}` : ''
        console.log()
        console.log(`  ${chalk.bold.white(field.label)}${valuePart}`)
        continue
      }
      if (field.value == null || field.value === '') continue
      keyValue(field.label, field.value, pad, { noColon: field.noColon, keyStyle: field.keyStyle, fill: field.fill })
    }

    // Separator between items (not after the last one)
    if (i < items.length - 1) {
      console.log()
    }
  }
}

// -- Pagination --

export function showPagination(pagination: { page: number; limit: number; totalCount: number; hasMore: boolean } | undefined, returnedCount?: number): void {
  if (!pagination) return
  const { page, limit, totalCount, hasMore } = pagination
  const showing = returnedCount ?? Math.min(limit, totalCount - (page - 1) * limit)
  console.log()
  dim(`Showing ${showing} of ${totalCount} (page ${page} of ${Math.ceil(totalCount / limit)})`)
  if (hasMore) {
    dim(`Use --page ${page + 1} to see next page`)
  }
}

// -- JSON output --

export function json(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

export function toon(data: unknown): void {
  try {
    console.log(encode(data))
  } catch {
    json(data)
  }
}

/** Output data in the specified structured format (json or toon). */
export function outputStructured(data: unknown, outputFormat: StructuredFormat): void {
  switch (outputFormat) {
    case 'json':
      json(data)
      break
    case 'toon':
      toon(data)
      break
  }
}

// -- Help colorizer --

export function colorizeHelp(text: string): string {
  return text
    .split('\n')
    .map(line => {
      if (line.includes('\x1b')) return line // already styled (e.g. banner, links)
      if (line.startsWith('Usage:')) return chalk.bold.white(line)
      if (/^(Options|Commands):/.test(line)) return chalk.bold.white(line)
      if (/^\s{2,}\S/.test(line)) {
        const match = line.match(/^(\s+)([\w<>[\].\-,/ |]+?)(\s{2,}.+)$/)
        if (match) {
          return match[1] + brandColor(match[2]) + chalk.dim(match[3])
        }
      }
      return line
    })
    .join('\n')
}

// -- Output mode helper --

/** Output an API result with optional meta and hints in structured format. */
export function outputApiResult(
  result: { data: unknown; meta?: unknown; hints?: string[] },
  outputFormat: StructuredFormat,
): void {
  const out: Record<string, unknown> = { data: result.data }

  const apiMeta = (result.meta ?? {}) as Record<string, unknown>
  const hasHints = result.hints && result.hints.length > 0
  const update = getUpdateInfo()
  if (result.meta || hasHints || update) {
    out.meta = {
      ...apiMeta,
      ...(hasHints ? { hints: result.hints } : {}),
      ...(update ? { update } : {}),
    }
  }

  outputStructured(out, outputFormat)
}

/**
 * Build a cluster color map from items that have a clusters array.
 * Assigns sequential color indices to each unique cluster ID.
 */
export function buildClusterColorMap(items: Array<{ clusters?: Array<{ id: string }> }>): Map<string, number> {
  const map = new Map<string, number>()
  for (const item of items) {
    for (const c of item.clusters ?? []) {
      if (!map.has(c.id)) {
        map.set(c.id, map.size)
      }
    }
  }
  return map
}

/** Format a large number as a human-readable string (e.g. 1.5M, 2.3B). */
export function formatLargeNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`
  return n.toFixed(2)
}

/** Format a percentage change with color (green for positive, red for negative). */
export function formatChange(change: number): string {
  const text = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`
  return change >= 0 ? fmt.green(text) : fmt.red(text)
}
