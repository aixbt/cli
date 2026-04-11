import chalk from 'chalk'
import { fmt } from './output.js'

type CandleTuple = (number | null)[]

interface CandlestickOptions {
  height?: number
  width?: number
  projectName?: string
  interval?: string
}

export function renderCandlestickChart(
  candles: CandleTuple[],
  options: CandlestickOptions = {},
): string {
  if (!candles || candles.length === 0) {
    return chalk.dim('No candle data to display.')
  }

  const termRows = process.stdout.rows || 24
  const termCols = process.stdout.columns || 80

  const height = options.height ?? Math.min(40, Math.max(10, Math.floor(termRows * 0.6)))
  const priceAxisWidth = 12
  const availableWidth = (options.width ?? termCols) - priceAxisWidth - 1

  // Downsample: take most recent N
  const displayCandles = candles.length > availableWidth ? candles.slice(-availableWidth) : candles

  // Parse candles
  const parsed = displayCandles.map(c => ({
    ts: c[0] as number,
    open: c[1] as number,
    high: c[2] as number,
    low: c[3] as number,
    close: c[4] as number,
    vol: c[5] as number | null,
  })).filter(c => c.open != null && c.high != null && c.low != null && c.close != null)

  if (parsed.length === 0) {
    return chalk.dim('No valid candle data to display.')
  }

  // Price range
  const globalHigh = Math.max(...parsed.map(c => c.high))
  const globalLow = Math.min(...parsed.map(c => c.low))
  const priceRange = globalHigh - globalLow || 1

  // Build grid
  const grid: string[][] = Array.from({ length: height }, () => Array(parsed.length).fill(' '))

  const priceToRow = (price: number): number => {
    const range = globalHigh - globalLow || 1
    const normalized = (globalHigh - price) / range
    return Math.min(height - 1, Math.max(0, Math.round(normalized * (height - 1))))
  }

  for (let col = 0; col < parsed.length; col++) {
    const c = parsed[col]
    const isUp = c.close >= c.open
    const bodyTop = Math.max(c.open, c.close)
    const bodyBot = Math.min(c.open, c.close)

    const highRow = priceToRow(c.high)
    const lowRow = priceToRow(c.low)
    const bodyTopRow = priceToRow(bodyTop)
    const bodyBotRow = priceToRow(bodyBot)

    const color = isUp ? fmt.green : fmt.red
    const bodyChar = '┃'
    const wickChar = '│'

    for (let row = highRow; row < bodyTopRow; row++) {
      grid[row][col] = color(wickChar)
    }
    for (let row = bodyTopRow; row <= bodyBotRow; row++) {
      grid[row][col] = color(bodyChar)
    }
    for (let row = bodyBotRow + 1; row <= lowRow; row++) {
      grid[row][col] = color(wickChar)
    }
    if (highRow === lowRow) {
      grid[highRow][col] = color('─')
    }
  }

  // Build output with price axis
  const lines: string[] = []
  const labelInterval = Math.max(1, Math.floor(height / 5))
  for (let row = 0; row < height; row++) {
    let label = ''
    if (row % labelInterval === 0 || row === height - 1) {
      const price = globalHigh - (row / (height - 1)) * priceRange
      label = formatPriceLabel(price)
    }
    const paddedLabel = label.padStart(priceAxisWidth - 1) + '│'
    lines.push(paddedLabel + grid[row].join(''))
  }

  // Time axis
  lines.push(' '.repeat(priceAxisWidth - 1) + '└' + '─'.repeat(parsed.length))
  const timeLabels = buildTimeAxisLabels(parsed.map(c => c.ts), parsed.length, priceAxisWidth)
  if (timeLabels) {
    lines.push(timeLabels)
  }

  // Summary line
  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  const change = ((last.close - first.open) / first.open) * 100
  const changeStr = change >= 0 ? fmt.green(`+${change.toFixed(2)}%`) : fmt.red(`${change.toFixed(2)}%`)
  const priceStr = `$${last.close.toPrecision(6)}`

  const summaryParts: string[] = []
  if (options.projectName) summaryParts.push(chalk.bold(options.projectName))
  if (options.interval) summaryParts.push(chalk.dim(options.interval))
  summaryParts.push(priceStr)
  summaryParts.push(changeStr)
  summaryParts.push(chalk.dim(`${parsed.length} candles`))

  lines.push('')
  lines.push(summaryParts.join('  '))

  return lines.join('\n')
}

function formatPriceLabel(price: number): string {
  if (price >= 1000) return price.toFixed(0)
  if (price >= 1) return price.toFixed(2)
  if (price >= 0.01) return price.toFixed(4)
  return price.toPrecision(4)
}

function buildTimeAxisLabels(timestamps: number[], count: number, offset: number): string | null {
  if (count < 3) return null
  const labelCount = Math.min(5, count)
  const step = Math.floor((count - 1) / (labelCount - 1))
  const labels: Array<{ col: number; text: string }> = []

  for (let i = 0; i < labelCount; i++) {
    const idx = Math.min(i * step, count - 1)
    const date = new Date(timestamps[idx])
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const min = String(date.getMinutes()).padStart(2, '0')
    labels.push({ col: idx, text: `${month}/${day} ${hour}:${min}` })
  }

  const line = Array(count + offset).fill(' ')
  for (const l of labels) {
    const pos = l.col + offset
    for (let i = 0; i < l.text.length && pos + i < line.length; i++) {
      line[pos + i] = l.text[i]
    }
  }
  return chalk.dim(line.join(''))
}
