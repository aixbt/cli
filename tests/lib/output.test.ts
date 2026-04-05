import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// -- Mock ora (suppress spinners in tests and allow spy assertions) --
// The mockSpinnerInstance is shared across all tests that use withSpinner.
// vi.mock is hoisted, but the factory can reference variables declared with `const`
// at the top level of the test file because vitest handles the hoisting.

const mockSpinnerInstance: Record<string, ReturnType<typeof vi.fn>> = {}
mockSpinnerInstance.start = vi.fn(() => mockSpinnerInstance)
mockSpinnerInstance.stop = vi.fn(() => mockSpinnerInstance)
mockSpinnerInstance.succeed = vi.fn(() => mockSpinnerInstance)
mockSpinnerInstance.fail = vi.fn(() => mockSpinnerInstance)

vi.mock('ora', () => {
  return {
    default: vi.fn(() => mockSpinnerInstance),
  }
})

import {
  fmt,
  success,
  error,
  warn,
  info,
  dim,
  label,
  keyValue,
  json,
  toon,
  isStructuredFormat,
  outputStructured,
  maskApiKey,
  table,
  outputApiResult,
  colorizeHelp,
  hint,
  cards,
  withSpinner,
} from '../../src/lib/output.js'

import type { TableColumn, CardItem } from '../../src/lib/output.js'

// -- Helpers --

/**
 * Strip ANSI escape codes from a string so we can assert on text content
 * without worrying about chalk color codes.
 */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '')
}

// -- maskApiKey --

describe('maskApiKey', () => {
  it('should return **** for short keys (8 chars or fewer)', () => {
    expect(maskApiKey('abc')).toBe('****')
    expect(maskApiKey('12345678')).toBe('****')
    expect(maskApiKey('')).toBe('****')
    expect(maskApiKey('a')).toBe('****')
  })

  it('should show first 6 and last 4 chars with ... for long keys', () => {
    // 9 chars: "123456789" -> "123456...6789"
    expect(maskApiKey('123456789')).toBe('123456...6789')
    // 20 chars
    expect(maskApiKey('abcdef1234567890wxyz')).toBe('abcdef...wxyz')
  })

  it('should handle exactly 9 character key (boundary)', () => {
    const key = 'abcdefghi' // 9 chars
    expect(maskApiKey(key)).toBe('abcdef...fghi')
  })
})

// -- Logging helpers --

describe('logging helpers', () => {
  let mockLog: ReturnType<typeof vi.spyOn>
  let mockError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
    mockError = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('success', () => {
    it('should write to stdout with OK prefix and green text', () => {
      success('done')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toBe('OK done')
    })
  })

  describe('error', () => {
    it('should write to stderr with error: prefix', () => {
      error('something broke')

      expect(mockError).toHaveBeenCalledOnce()
      const output = stripAnsi(mockError.mock.calls[0][0] as string)
      expect(output).toBe('error: something broke')
    })
  })

  describe('warn', () => {
    it('should write to stderr with warn: prefix', () => {
      warn('be careful')

      expect(mockError).toHaveBeenCalledOnce()
      const output = stripAnsi(mockError.mock.calls[0][0] as string)
      expect(output).toBe('warn: be careful')
    })
  })

  describe('info', () => {
    it('should write to stdout with brand-colored text', () => {
      info('status update')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toBe('status update')
    })
  })

  describe('dim', () => {
    it('should write to stdout with dimmed text', () => {
      dim('subtle message')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toBe('subtle message')
    })
  })

  describe('label', () => {
    it('should write to stdout with branded key and value', () => {
      label('Name', 'Test Project')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toBe('Name:  Test Project')
    })
  })

  describe('keyValue', () => {
    it('should write to stdout with padded key-value pair', () => {
      keyValue('Status', 'active')

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      // "Status:" is 7 chars, pad = 18, padding = 18 - 6 = 12 spaces
      expect(output).toContain('Status:')
      expect(output).toContain('active')
    })

    it('should respect custom pad parameter', () => {
      keyValue('ID', '123', 10)

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toContain('ID:')
      expect(output).toContain('123')
    })

    it('should handle key longer than pad gracefully', () => {
      // When key.length > pad, Math.max(0, pad - key.length) = 0
      keyValue('VeryLongKeyName', 'val', 5)

      expect(mockLog).toHaveBeenCalledOnce()
      const output = stripAnsi(mockLog.mock.calls[0][0] as string)
      expect(output).toContain('VeryLongKeyName:')
      expect(output).toContain('val')
    })
  })

  describe('json', () => {
    it('should write pretty-printed JSON to stdout', () => {
      const data = { name: 'test', count: 42 }
      json(data)

      expect(mockLog).toHaveBeenCalledOnce()
      expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2))
    })

    it('should handle arrays', () => {
      const data = [1, 2, 3]
      json(data)

      expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2))
    })

    it('should handle null', () => {
      json(null)

      expect(mockLog).toHaveBeenCalledWith('null')
    })
  })
})

// -- Table formatter --

describe('human', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const basicColumns: TableColumn[] = [
    { key: 'name', header: 'Name' },
    { key: 'value', header: 'Value' },
  ]

  it('should print "No results." for empty data array', () => {
    table([], basicColumns)

    expect(mockLog).toHaveBeenCalledOnce()
    const output = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(output).toBe('No results.')
  })

  it('should render a single row with header, separator, and data', () => {
    const data = [{ name: 'Alice', value: '100' }]
    table(data, basicColumns)

    // Expect: header line, separator line, one data line = 3 calls
    expect(mockLog).toHaveBeenCalledTimes(3)

    const headerLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    const separatorLine = stripAnsi(mockLog.mock.calls[1][0] as string)
    const dataLine = stripAnsi(mockLog.mock.calls[2][0] as string)

    expect(headerLine).toContain('Name')
    expect(headerLine).toContain('Value')
    expect(separatorLine).toMatch(/^─+$/)
    expect(dataLine).toContain('Alice')
    expect(dataLine).toContain('100')
  })

  it('should render multiple rows correctly', () => {
    const data = [
      { name: 'Alice', value: '100' },
      { name: 'Bob', value: '200' },
      { name: 'Charlie', value: '300' },
    ]
    table(data, basicColumns)

    // header + separator + 3 data rows = 5 calls
    expect(mockLog).toHaveBeenCalledTimes(5)

    const row1 = stripAnsi(mockLog.mock.calls[2][0] as string)
    const row2 = stripAnsi(mockLog.mock.calls[3][0] as string)
    const row3 = stripAnsi(mockLog.mock.calls[4][0] as string)

    expect(row1).toContain('Alice')
    expect(row2).toContain('Bob')
    expect(row3).toContain('Charlie')
  })

  it('should auto-calculate column widths from data', () => {
    const data = [
      { name: 'A', value: 'Short' },
      { name: 'LongerName', value: 'X' },
    ]
    table(data, basicColumns)

    const headerLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    const dataLine1 = stripAnsi(mockLog.mock.calls[2][0] as string)
    const dataLine2 = stripAnsi(mockLog.mock.calls[3][0] as string)

    // "LongerName" is 10 chars, wider than header "Name" (4 chars),
    // so column width is max(4, 10) + 2 = 12
    // "A" should be padded to the same width
    expect(dataLine1).toContain('A')
    expect(dataLine2).toContain('LongerName')
    // Both rows should have the same structure
    expect(headerLine.length).toBe(dataLine1.length)
  })

  it('should support right-aligned columns', () => {
    const columns: TableColumn[] = [
      { key: 'name', header: 'Name' },
      { key: 'amount', header: 'Amount', align: 'right' },
    ]
    const data = [{ name: 'Alice', amount: '42' }]
    table(data, columns)

    const dataLine = stripAnsi(mockLog.mock.calls[2][0] as string)
    // For right-aligned "42" in a wider column, there should be leading spaces
    // before "42" in the amount segment
    const parts = dataLine.split('  ') // columns are joined by "  "
    const amountPart = parts[parts.length - 1].trimEnd()
    // Right-aligned means the value is at the right side
    expect(amountPart.endsWith('42')).toBe(true)
  })

  it('should apply custom format function to values', () => {
    const columns: TableColumn[] = [
      { key: 'name', header: 'Name' },
      {
        key: 'price',
        header: 'Price',
        format: (v) => `$${Number(v).toFixed(2)}`,
      },
    ]
    const data = [{ name: 'Widget', price: 9.5 }]
    table(data, columns)

    const dataLine = stripAnsi(mockLog.mock.calls[2][0] as string)
    expect(dataLine).toContain('$9.50')
  })

  it('should wrap long values across multiple lines when exceeding column width', () => {
    // Mock a narrow terminal to force wrapping
    const origColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: 40, writable: true, configurable: true })

    const columns: TableColumn[] = [
      { key: 'desc', header: 'Description' },
    ]
    const data = [{ desc: 'This is a very long description that exceeds the column width' }]
    table(data, columns)

    // There should be more than 3 calls (header, separator, + multiple wrapped lines)
    expect(mockLog.mock.calls.length).toBeGreaterThan(3)

    // Collect all data lines (after header and separator)
    const dataLines = mockLog.mock.calls.slice(2).map(
      (call) => stripAnsi(call[0] as string),
    )

    // All parts of the original text should appear across the wrapped lines
    const allText = dataLines.join(' ')
    expect(allText).toContain('This')
    expect(allText).toContain('description')
    expect(allText).toContain('column')
    expect(allText).toContain('width')

    // No line should contain the "..." truncation marker
    for (const line of dataLines) {
      expect(line).not.toContain('...')
    }

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, writable: true, configurable: true })
  })

  it('should render null and undefined values as empty string', () => {
    const columns: TableColumn[] = [
      { key: 'a', header: 'A' },
      { key: 'b', header: 'B' },
    ]
    const data = [{ a: null, b: undefined } as unknown as Record<string, unknown>]
    table(data, columns)

    const dataLine = stripAnsi(mockLog.mock.calls[2][0] as string)
    // Should not contain "null" or "undefined" text
    expect(dataLine).not.toContain('null')
    expect(dataLine).not.toContain('undefined')
  })

  it('should respect explicit column width', () => {
    const columns: TableColumn[] = [
      { key: 'name', header: 'Name', width: 20 },
    ]
    const data = [{ name: 'Short' }]
    table(data, columns)

    const headerLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    // With explicit width 20, header "Name" should be padded to 20 chars
    expect(headerLine.length).toBeGreaterThanOrEqual(20)
  })

  it('should read process.stdout.columns for terminal width', () => {
    const origColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: 120, writable: true, configurable: true })

    const columns: TableColumn[] = [
      { key: 'name', header: 'Name' },
      { key: 'value', header: 'Value' },
    ]
    const data = [{ name: 'Alice', value: '100' }]
    table(data, columns)

    // The separator line should respect the terminal width
    const separatorLine = stripAnsi(mockLog.mock.calls[1][0] as string)
    expect(separatorLine.length).toBeLessThanOrEqual(120)

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, writable: true, configurable: true })
  })

  it('should fall back to 80 columns when process.stdout.columns is undefined', () => {
    const origColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: undefined, writable: true, configurable: true })

    const columns: TableColumn[] = [
      { key: 'name', header: 'Name' },
      { key: 'desc', header: 'Description' },
    ]
    // Use a value long enough to exceed 80 columns but not excessively long
    const data = [{ name: 'Test', desc: 'A description that is somewhat long to test fallback behavior with default width' }]
    table(data, columns)

    // The separator should not exceed the fallback width of 80
    const separatorLine = stripAnsi(mockLog.mock.calls[1][0] as string)
    expect(separatorLine.length).toBeLessThanOrEqual(80)

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, writable: true, configurable: true })
  })

  it('should wrap text at word boundaries when possible', () => {
    const origColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: 30, writable: true, configurable: true })

    const columns: TableColumn[] = [
      { key: 'text', header: 'Text' },
    ]
    const data = [{ text: 'hello world foo bar baz qux' }]
    table(data, columns)

    // Collect all data lines (after header and separator)
    const dataLines = mockLog.mock.calls.slice(2).map(
      (call) => stripAnsi(call[0] as string).trimEnd(),
    )

    // Verify words are not split in the middle
    for (const line of dataLines) {
      const trimmed = line.trim()
      if (trimmed.length > 0) {
        // Each line should contain complete words (no partial words broken mid-character)
        const words = trimmed.split(/\s+/)
        for (const word of words) {
          expect('hello world foo bar baz qux').toContain(word)
        }
      }
    }

    Object.defineProperty(process.stdout, 'columns', { value: origColumns, writable: true, configurable: true })
  })
})

// -- outputApiResult --

describe('outputApiResult', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should output JSON with data and meta when meta is present', () => {
    outputApiResult({ data: [{ name: 'test' }], meta: { tier: 'free' } }, 'json')

    expect(mockLog).toHaveBeenCalledOnce()
    const parsed = JSON.parse(mockLog.mock.calls[0][0] as string)
    expect(parsed).toEqual({ data: [{ name: 'test' }], meta: { tier: 'free' } })
  })

  it('should output JSON with data only when meta is undefined', () => {
    outputApiResult({ data: [{ name: 'test' }] }, 'json')

    expect(mockLog).toHaveBeenCalledOnce()
    const parsed = JSON.parse(mockLog.mock.calls[0][0] as string)
    expect(parsed).toEqual({ data: [{ name: 'test' }] })
    expect(parsed).not.toHaveProperty('meta')
  })

  it('should output TOON format', () => {
    outputApiResult({ data: [{ name: 'test' }] }, 'toon')

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(output).toContain('test')
  })

  it('should include pagination in JSON when present', () => {
    const pagination = { page: 1, limit: 50, totalCount: 168, hasMore: true }
    outputApiResult({ data: [{ id: '1' }], pagination }, 'json')

    const parsed = JSON.parse(mockLog.mock.calls[0][0] as string)
    expect(parsed.pagination).toEqual(pagination)
  })

  it('should omit pagination in JSON when undefined', () => {
    outputApiResult({ data: [{ id: '1' }] }, 'json')

    const parsed = JSON.parse(mockLog.mock.calls[0][0] as string)
    expect(parsed).not.toHaveProperty('pagination')
  })

  it('should include pagination alongside meta and data', () => {
    const pagination = { page: 2, limit: 10, totalCount: 50, hasMore: true }
    outputApiResult({ data: [{ id: '1' }], pagination, meta: { tier: 'paid' } }, 'json')

    const parsed = JSON.parse(mockLog.mock.calls[0][0] as string)
    expect(parsed.data).toEqual([{ id: '1' }])
    expect(parsed.pagination).toEqual(pagination)
    expect(parsed.meta).toMatchObject({ tier: 'paid' })
  })
})

// -- toon --

describe('toon', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should encode object with key-value pairs', () => {
    const data = { name: 'test', count: 42 }
    toon(data)

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(output).toContain('name: test')
    expect(output).toContain('count: 42')
    expect(output).not.toContain('{')
  })

  it('should encode arrays in columnar format', () => {
    const data = [{ name: 'a' }, { name: 'b' }]
    toon(data)

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(output).toContain('a')
    expect(output).toContain('b')
    expect(output).toContain('name')
    // TOON does not use JSON's quoted key syntax
    expect(output).not.toContain('"name"')
  })
})

// -- isStructuredFormat --

describe('isStructuredFormat', () => {
  it('should return false for human format', () => {
    expect(isStructuredFormat('human')).toBe(false)
  })

  it('should return true for json format', () => {
    expect(isStructuredFormat('json')).toBe(true)
  })

  it('should return true for toon format', () => {
    expect(isStructuredFormat('toon')).toBe(true)
  })
})

// -- outputStructured --

describe('outputStructured', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should output JSON for json format', () => {
    const data = { key: 'value' }
    outputStructured(data, 'json')

    expect(mockLog).toHaveBeenCalledOnce()
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2))
  })

  it('should output TOON for toon format', () => {
    const data = { key: 'value' }
    outputStructured(data, 'toon')

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(typeof output).toBe('string')
    expect(output).not.toBe(JSON.stringify(data, null, 2))
  })

})

// -- colorizeHelp --

describe('colorizeHelp', () => {
  it('should process "Usage:" lines and preserve text content', () => {
    const input = 'Usage: aixbt [options]'
    const result = colorizeHelp(input)
    const stripped = stripAnsi(result)

    expect(stripped).toBe('Usage: aixbt [options]')
  })

  it('should process "Options:" lines and preserve text content', () => {
    const input = 'Options:'
    const result = colorizeHelp(input)
    const stripped = stripAnsi(result)

    expect(stripped).toBe('Options:')
  })

  it('should process "Commands:" lines and preserve text content', () => {
    const input = 'Commands:'
    const result = colorizeHelp(input)
    const stripped = stripAnsi(result)

    expect(stripped).toBe('Commands:')
  })

  it('should pass through regular content lines unchanged', () => {
    const input = 'This is a regular line'
    const result = colorizeHelp(input)

    expect(result).toBe(input)
  })

  it('should process command/option lines with leading spaces', () => {
    const input = '  login          Log in to AIXBT'
    const result = colorizeHelp(input)
    const stripped = stripAnsi(result)

    // The content should still be present after colorization
    expect(stripped).toContain('login')
    expect(stripped).toContain('Log in to AIXBT')
  })

  it('should handle multi-line help text preserving all content', () => {
    const input = [
      'Usage: aixbt [options]',
      '',
      'Options:',
      '  --help     Show help',
      '  --version  Show version',
      '',
      'Commands:',
      '  login      Log in',
    ].join('\n')

    const result = colorizeHelp(input)
    const lines = result.split('\n')
    const strippedLines = lines.map(stripAnsi)

    expect(strippedLines[0]).toBe('Usage: aixbt [options]')
    expect(strippedLines[1]).toBe('')
    expect(strippedLines[2]).toBe('Options:')
    expect(strippedLines[3]).toContain('--help')
    expect(strippedLines[3]).toContain('Show help')
    expect(strippedLines[6]).toBe('Commands:')
    expect(strippedLines[7]).toContain('login')
    expect(strippedLines[7]).toContain('Log in')
  })

  it('should preserve line count in output', () => {
    const input = 'Usage: test\nOptions:\n  --foo  bar\nCommands:\n  run  execute'
    const result = colorizeHelp(input)

    expect(result.split('\n').length).toBe(input.split('\n').length)
  })

  it('should not modify lines that do not match any pattern', () => {
    const input = 'Some documentation text without special formatting'
    const result = colorizeHelp(input)

    expect(result).toBe(input)
  })
})

// -- Card layout --

describe('cards', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should print "No results." for empty array', () => {
    cards([])

    expect(mockLog).toHaveBeenCalledOnce()
    const output = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(output).toBe('No results.')
  })

  it('should render single card with title and fields', () => {
    const items: CardItem[] = [
      {
        title: 'My Project',
        fields: [
          { label: 'Status', value: 'active' },
          { label: 'Type', value: 'DeFi' },
        ],
      },
    ]
    cards(items)

    const allOutput = mockLog.mock.calls.map((call) => stripAnsi(call[0] as string))
    // Title line
    expect(allOutput[0]).toContain('My Project')
    // Field lines
    const fieldsText = allOutput.slice(1).join(' ')
    expect(fieldsText).toContain('Status:')
    expect(fieldsText).toContain('active')
    expect(fieldsText).toContain('Type:')
    expect(fieldsText).toContain('DeFi')
  })

  it('should render multiple cards with separators between them', () => {
    const items: CardItem[] = [
      {
        title: 'Card One',
        fields: [{ label: 'A', value: '1' }],
      },
      {
        title: 'Card Two',
        fields: [{ label: 'B', value: '2' }],
      },
    ]
    cards(items)

    const allOutput = mockLog.mock.calls.map((call) =>
      call[0] === undefined ? '' : stripAnsi(call[0] as string),
    )
    // There should be a blank line (separator) between cards
    // Card 1: title line + field line, then blank line, then Card 2: title + field
    expect(allOutput.some((line) => line === '')).toBe(true)
    // Both card titles should appear
    expect(allOutput.some((line) => line.includes('Card One'))).toBe(true)
    expect(allOutput.some((line) => line.includes('Card Two'))).toBe(true)
  })

  it('should render badge before title', () => {
    const items: CardItem[] = [
      {
        title: 'My Project',
        badge: '[HOT]',
        fields: [],
      },
    ]
    cards(items)

    const titleLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(titleLine).toContain('[HOT]')
    expect(titleLine).toContain('My Project')
    // Badge should appear before the title
    const badgeIdx = titleLine.indexOf('[HOT]')
    const titleIdx = titleLine.indexOf('My Project')
    expect(badgeIdx).toBeLessThan(titleIdx)
  })

  it('should render subtitle dimmed after title', () => {
    const items: CardItem[] = [
      {
        title: 'My Project',
        subtitle: 'v2.0',
        fields: [],
      },
    ]
    cards(items)

    const titleLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(titleLine).toContain('My Project')
    expect(titleLine).toContain('v2.0')
    // Subtitle should appear after the title
    const titleIdx = titleLine.indexOf('My Project')
    const subtitleIdx = titleLine.indexOf('v2.0')
    expect(subtitleIdx).toBeGreaterThan(titleIdx)
  })

  it('should skip null and empty field values', () => {
    const items: CardItem[] = [
      {
        title: 'Test',
        fields: [
          { label: 'Visible', value: 'yes' },
          { label: 'Null', value: null },
          { label: 'Undefined', value: undefined },
          { label: 'Empty', value: '' },
          { label: 'AlsoVisible', value: 'indeed' },
        ],
      },
    ]
    cards(items)

    const allOutput = mockLog.mock.calls.map((call) => stripAnsi(call[0] as string))
    const allText = allOutput.join('\n')
    // Visible fields should be present
    expect(allText).toContain('Visible:')
    expect(allText).toContain('yes')
    expect(allText).toContain('AlsoVisible:')
    expect(allText).toContain('indeed')
    // Null/undefined/empty labels should NOT appear as field lines
    // (They should be entirely skipped, not rendered with empty values)
    const fieldLines = allOutput.filter((line) => line.includes('Null:'))
    expect(fieldLines.length).toBe(0)
    const undefinedLines = allOutput.filter((line) => line.includes('Undefined:'))
    expect(undefinedLines.length).toBe(0)
    const emptyLines = allOutput.filter((line) => line.includes('Empty:'))
    expect(emptyLines.length).toBe(0)
  })
})

// -- Spinner / withSpinner --

describe('withSpinner', () => {
  beforeEach(() => {
    mockSpinnerInstance.start.mockClear()
    mockSpinnerInstance.stop.mockClear()
    mockSpinnerInstance.succeed.mockClear()
    mockSpinnerInstance.fail.mockClear()
  })

  it('should call stop() instead of succeed() when silent option is true', async () => {
    const result = await withSpinner(
      'Loading',
      'human',
      async () => 'done',
      undefined,
      { silent: true },
    )
    expect(result).toBe('done')
    // With silent: true, stop() should be called, not succeed()
    expect(mockSpinnerInstance.stop).toHaveBeenCalled()
    expect(mockSpinnerInstance.succeed).not.toHaveBeenCalled()
  })

  it('should call succeed() when no opts passed (backward compatibility)', async () => {
    const result = await withSpinner(
      'Loading',
      'human',
      async () => ({ data: 42 }),
    )
    expect(result).toEqual({ data: 42 })
    // Without silent option, succeed() should be called
    expect(mockSpinnerInstance.succeed).toHaveBeenCalled()
    expect(mockSpinnerInstance.stop).not.toHaveBeenCalled()
  })

  it('should skip spinner entirely for structured formats', async () => {
    const result = await withSpinner(
      'Loading',
      'json',
      async () => 'structured-result',
    )
    expect(result).toBe('structured-result')
    // For structured formats, spinner is null so no methods should be called
    expect(mockSpinnerInstance.start).not.toHaveBeenCalled()
    expect(mockSpinnerInstance.stop).not.toHaveBeenCalled()
    expect(mockSpinnerInstance.succeed).not.toHaveBeenCalled()
  })

  it('should rethrow errors from the async function', async () => {
    await expect(
      withSpinner(
        'Loading',
        'json',
        async () => { throw new Error('boom') },
        'Load failed',
      ),
    ).rejects.toThrow('boom')
  })
})

// -- Hint --

describe('hint', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should print blank line then dimmed message', () => {
    hint('Try --verbose for more details')

    // hint() calls console.log() twice: once with no args (blank line), once with dimmed text
    expect(mockLog).toHaveBeenCalledTimes(2)
    // First call: blank line (no arguments)
    expect(mockLog.mock.calls[0]).toEqual([])
    // Second call: the dimmed message text
    const output = stripAnsi(mockLog.mock.calls[1][0] as string)
    expect(output).toBe('Try --verbose for more details')
  })
})

// -- String formatters (fmt) --

describe('fmt', () => {
  it('should have a brand function that returns the text content', () => {
    const result = fmt.brand('hello')
    const stripped = stripAnsi(result)

    expect(stripped).toBe('hello')
    expect(typeof result).toBe('string')
  })

  it('should have a brandBold function that returns the text content', () => {
    const result = fmt.brandBold('hello')
    const stripped = stripAnsi(result)

    expect(stripped).toBe('hello')
    expect(typeof result).toBe('string')
  })

  it('should have brand and brandBold as callable functions', () => {
    expect(typeof fmt.brand).toBe('function')
    expect(typeof fmt.brandBold).toBe('function')
  })

  it('should have dim, green, red, and yellow formatters', () => {
    expect(stripAnsi(fmt.dim('test'))).toBe('test')
    expect(stripAnsi(fmt.green('test'))).toBe('test')
    expect(stripAnsi(fmt.red('test'))).toBe('test')
    expect(stripAnsi(fmt.yellow('test'))).toBe('test')
  })

  it('should return string type for all formatters', () => {
    expect(typeof fmt.dim('x')).toBe('string')
    expect(typeof fmt.green('x')).toBe('string')
    expect(typeof fmt.red('x')).toBe('string')
    expect(typeof fmt.yellow('x')).toBe('string')
  })
})
