import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
  outputResult,
  colorizeHelp,
} from '../../src/lib/output.js'

import type { TableColumn } from '../../src/lib/output.js'

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

describe('table', () => {
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
    expect(separatorLine).toMatch(/^-+$/)
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

  it('should truncate long values with ...', () => {
    const columns: TableColumn[] = [
      { key: 'desc', header: 'Description', width: 10 },
    ]
    const data = [{ desc: 'This is a very long description that exceeds the column width' }]
    table(data, columns)

    const dataLine = stripAnsi(mockLog.mock.calls[2][0] as string)
    expect(dataLine).toContain('...')
    // The truncated value should not exceed the column width
    expect(dataLine.trim().length).toBeLessThanOrEqual(10)
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
})

// -- outputResult --

describe('outputResult', () => {
  let mockLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mockLog = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const columns: TableColumn[] = [
    { key: 'name', header: 'Name' },
  ]

  it('should output JSON when format is json', () => {
    const data = [{ name: 'test' }]
    outputResult(data, columns, 'json')

    expect(mockLog).toHaveBeenCalledOnce()
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2))
  })

  it('should output table when format is table', () => {
    const data = [{ name: 'test' }]
    outputResult(data, columns, 'table')

    // Table produces: header + separator + data row = 3 calls
    expect(mockLog).toHaveBeenCalledTimes(3)
    const headerLine = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(headerLine).toContain('Name')
  })

  it('should output TOON when format is toon', () => {
    const data = [{ name: 'test' }]
    outputResult(data, columns, 'toon')

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(typeof output).toBe('string')
    expect(output).not.toBe(JSON.stringify(data, null, 2))
  })

  it('should output "No results." table for empty data in table format', () => {
    outputResult([], columns, 'table')

    expect(mockLog).toHaveBeenCalledOnce()
    const output = stripAnsi(mockLog.mock.calls[0][0] as string)
    expect(output).toBe('No results.')
  })

  it('should output empty JSON array for empty data in json format', () => {
    outputResult([], columns, 'json')

    expect(mockLog).toHaveBeenCalledOnce()
    expect(mockLog).toHaveBeenCalledWith('[]')
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

  it('should call encode and write to stdout', () => {
    const data = { name: 'test', count: 42 }
    toon(data)

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(typeof output).toBe('string')
    expect(output).not.toBe(JSON.stringify(data, null, 2))
  })

  it('should handle arrays', () => {
    const data = [{ name: 'a' }, { name: 'b' }]
    toon(data)

    expect(mockLog).toHaveBeenCalledOnce()
    const output = mockLog.mock.calls[0][0] as string
    expect(typeof output).toBe('string')
  })
})

// -- isStructuredFormat --

describe('isStructuredFormat', () => {
  it('should return false for table format', () => {
    expect(isStructuredFormat('table')).toBe(false)
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

  it('should fall back to JSON for table format', () => {
    const data = { key: 'value' }
    outputStructured(data, 'table')

    expect(mockLog).toHaveBeenCalledOnce()
    expect(mockLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2))
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
