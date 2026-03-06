import chalk from 'chalk'
import ora from 'ora'
import type { Ora } from 'ora'
import { encode } from '@toon-format/toon'

export type OutputFormat = 'table' | 'json' | 'toon'

/** Returns true for formats that produce structured (machine-readable) output. */
export function isStructuredFormat(format: OutputFormat): boolean {
  return format !== 'table'
}

// -- Brand --

const BRAND_HEX = '#b07de3'  // AIXBT brand purple
const brandColor = chalk.hex(BRAND_HEX)
const brandBold = brandColor.bold

// -- Banner --

const GREETINGS = [
  'Sidelined?',
  'Trenches never sleep',
  'Buy high sell higher',
  'Believe in something',
  'Still early',
]

const P = chalk.rgb(148, 104, 196) // purple-300
const C = chalk.rgb(70, 173, 195)  // cyan-500
const G = chalk.rgb(50, 50, 61)    // gray-400

export function banner(version: string): string {
  const d = chalk.dim
  const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)]
  return [
    '',
    `    ${P('▄██▄██▄')}   ${chalk.bold.white('aixbt')}`,
    `   ${P('██')}${chalk.black.bgRgb(148, 104, 196)('▀')}${chalk.white.bgRgb(148, 104, 196)('▀')}${chalk.black.bgRgb(148, 104, 196)('▀▀')}${chalk.white.bgRgb(148, 104, 196)('▀')}${P('▀')}`,
    `  ${P('████')}${C.bgRgb(148, 104, 196)('▀▀▀')}${C('▀')}    ${chalk.cyan(greeting)}`,
    `  ${G('▀▀▀▀▀▀▀')}`,
    '',
    `${chalk.bold.white('Guide:')} ${d('https://docs.aixbt.tech/builders/cli')}`,
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
): Promise<T> {
  const spin = isStructuredFormat(outputFormat) ? null : spinner(text)
  try {
    const result = await fn()
    spin?.succeed()
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

export function table<T extends Record<string, unknown>>(
  data: T[],
  columns: TableColumn[],
): void {
  if (data.length === 0) {
    dim('No results.')
    return
  }

  const widths = columns.map(col => {
    const headerLen = col.header.length
    const maxDataLen = data.reduce((max, row) => {
      const val = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')
      return Math.max(max, val.length)
    }, 0)
    return col.width ?? Math.min(Math.max(headerLen, maxDataLen) + 2, 40)
  })

  const headerLine = columns
    .map((col, i) => chalk.dim(col.header.padEnd(widths[i])))
    .join('  ')
  console.log(headerLine)
  console.log(chalk.dim('-'.repeat(headerLine.length)))

  for (const row of data) {
    const line = columns
      .map((col, i) => {
        const raw = col.format ? col.format(row[col.key]) : String(row[col.key] ?? '')
        const truncated = raw.length > widths[i] - 1
          ? raw.slice(0, widths[i] - 4) + '...'
          : raw
        return col.align === 'right'
          ? truncated.padStart(widths[i])
          : truncated.padEnd(widths[i])
      })
      .join('  ')
    console.log(line)
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
  console.log(encode(data))
}

/** Output data in the specified structured format (json or toon). */
export function outputStructured(data: unknown, outputFormat: OutputFormat): void {
  switch (outputFormat) {
    case 'json':
      json(data)
      break
    case 'toon':
      toon(data)
      break
    case 'table':
      json(data)
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
