import chalk from 'chalk'
import ora from 'ora'
import type { Ora } from 'ora'
import { encode } from '@toon-format/toon'

export type OutputFormat = 'table' | 'json' | 'toon'
export type StructuredFormat = 'json' | 'toon'

/** Returns true for formats that produce structured (machine-readable) output. */
export function isStructuredFormat(format: OutputFormat): format is StructuredFormat {
  return format !== 'table'
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
}

// -- Inquirer theme --

export const aixbtTheme = {
  prefix: brandColor('>>'),
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

export function hint(msg: string): void {
  console.log()
  console.log(chalk.dim(msg))
}

export function fullHint(): void {
  hint('Use --full for complete details')
}

export function label(key: string, value: string): void {
  console.log(`${chalk.bold.white(key + ':')}  ${value}`)
}

export function keyValue(key: string, value: string, pad = 18): void {
  const padding = Math.max(0, pad - key.length)
  console.log(`  ${chalk.dim(key + ':')}${' '.repeat(padding)} ${value}`)
}

export function spinner(text: string): Ora {
  return ora({ text, spinner: 'dots', color: 'cyan' }).start()
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

function getTerminalWidth(): number {
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
      : Math.min(col.header.length + 2, Math.floor(available / columns.length))
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

function wrapText(text: string, width: number, align?: 'left' | 'right'): string[] {
  if (width <= 0) return [text]
  if (text.length <= width) return [text]

  const lines: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= width) {
      lines.push(remaining)
      break
    }

    let breakAt = remaining.lastIndexOf(' ', width)
    if (breakAt <= 0) {
      breakAt = width
    }

    lines.push(remaining.slice(0, breakAt).trimEnd())
    remaining = remaining.slice(breakAt).trimStart()
  }

  return lines.length > 0 ? lines : ['']
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
      return Math.max(max, val.length)
    }, 0)
    const natural = Math.max(headerLen, maxDataLen) + 2
    return col.width ? Math.max(natural, col.width) : natural
  })

  const gutterWidth = (columns.length - 1) * 2
  const available = termWidth - gutterWidth

  const widths = distributeWidths(columns, contentWidths, available)

  const headerLine = columns
    .map((col, i) => chalk.dim(col.header.padEnd(widths[i])))
    .join('  ')
  console.log(headerLine)
  console.log(chalk.dim('-'.repeat(Math.min(headerLine.length, termWidth))))

  for (const row of data) {
    const cellValues = columns.map((col, i) => {
      const raw = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')
      return wrapText(raw, widths[i], col.align)
    })

    const maxLines = Math.max(...cellValues.map(v => v.length))

    for (let line = 0; line < maxLines; line++) {
      const rowLine = columns.map((col, i) => {
        const text = cellValues[i][line] ?? ''
        return col.align === 'right'
          ? text.padStart(widths[i])
          : text.padEnd(widths[i])
      }).join('  ')
      console.log(rowLine)
    }
  }
}

// -- Card layout --

export interface CardField {
  label: string
  value: string | undefined | null
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
    const subtitlePart = item.subtitle ? `  ${chalk.dim(item.subtitle)}` : ''
    console.log(`${badgePart}${chalk.bold.white(item.title)}${subtitlePart}`)

    // Fields
    for (const field of item.fields) {
      if (field.value == null || field.value === '') continue
      keyValue(field.label, field.value, pad)
    }

    // Separator between items (not after the last one)
    if (i < items.length - 1) {
      console.log()
    }
  }
}

// -- Pagination --

export function showPagination(pagination: { page: number; limit: number; totalCount: number; hasMore: boolean } | undefined): void {
  if (!pagination) return
  const { page, limit, totalCount, hasMore } = pagination
  console.log()
  dim(`Page ${page} of ${Math.ceil(totalCount / limit)} (${totalCount} total)`)
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
      if (line.includes('\x1b[')) return line // already styled (e.g. banner)
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

export function outputResult<T extends Record<string, unknown>>(
  data: T[],
  columns: TableColumn[],
  outputFormat: OutputFormat,
): void {
  switch (outputFormat) {
    case 'json':
      json(data)
      break
    case 'toon':
      toon(data)
      break
    case 'table':
      table(data, columns)
      break
  }
}
