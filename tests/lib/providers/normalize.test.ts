import { describe, it, expect } from 'vitest'

import {
  flattenJsonApiResource,
  flattenJsonApiResponse,
} from '../../../src/lib/providers/normalize.js'

describe('flattenJsonApiResource', () => {
  it('should flatten id, type, and attributes into a single object', () => {
    const resource = {
      id: '1',
      type: 'token',
      attributes: { name: 'ETH', symbol: 'ETH' },
    }
    expect(flattenJsonApiResource(resource)).toEqual({
      id: '1',
      type: 'token',
      name: 'ETH',
      symbol: 'ETH',
    })
  })

  it('should return id and type when attributes is missing', () => {
    const resource = { id: '1', type: 'token' }
    expect(flattenJsonApiResource(resource)).toEqual({
      id: '1',
      type: 'token',
    })
  })

  it('should return id and type when attributes is empty', () => {
    const resource = { id: '1', type: 'token', attributes: {} }
    expect(flattenJsonApiResource(resource)).toEqual({
      id: '1',
      type: 'token',
    })
  })

  it('should return empty object for null input', () => {
    expect(flattenJsonApiResource(null)).toEqual({})
  })

  it('should return empty object for undefined input', () => {
    expect(flattenJsonApiResource(undefined)).toEqual({})
  })

  it('should return empty object for string input', () => {
    expect(flattenJsonApiResource('not an object')).toEqual({})
  })

  it('should return empty object for number input', () => {
    expect(flattenJsonApiResource(42)).toEqual({})
  })

  it('should not preserve extra top-level fields like relationships', () => {
    const resource = {
      id: '1',
      type: 'token',
      attributes: { name: 'ETH' },
      relationships: { chain: { data: { id: '5', type: 'chain' } } },
    }
    const result = flattenJsonApiResource(resource)
    expect(result).toEqual({ id: '1', type: 'token', name: 'ETH' })
    expect(result).not.toHaveProperty('relationships')
  })

  it('should set id and type to undefined when resource lacks them', () => {
    const resource = { attributes: { name: 'ETH' } }
    const result = flattenJsonApiResource(resource)
    expect(result).toEqual({ id: undefined, type: undefined, name: 'ETH' })
  })

  it('should handle attributes with nested objects', () => {
    const resource = {
      id: '1',
      type: 'token',
      attributes: {
        name: 'ETH',
        metadata: { chain: 'ethereum', decimals: 18 },
      },
    }
    expect(flattenJsonApiResource(resource)).toEqual({
      id: '1',
      type: 'token',
      name: 'ETH',
      metadata: { chain: 'ethereum', decimals: 18 },
    })
  })

  it('should handle attributes with array values', () => {
    const resource = {
      id: '1',
      type: 'token',
      attributes: { tags: ['defi', 'layer1'] },
    }
    expect(flattenJsonApiResource(resource)).toEqual({
      id: '1',
      type: 'token',
      tags: ['defi', 'layer1'],
    })
  })
})

describe('flattenJsonApiResponse', () => {
  // -- Array data --

  it('should flatten each resource in an array data response', () => {
    const body = {
      data: [
        { id: '1', type: 'token', attributes: { name: 'ETH' } },
        { id: '2', type: 'token', attributes: { name: 'BTC' } },
      ],
    }
    expect(flattenJsonApiResponse(body)).toEqual([
      { id: '1', type: 'token', name: 'ETH' },
      { id: '2', type: 'token', name: 'BTC' },
    ])
  })

  it('should return empty array when data is an empty array', () => {
    const body = { data: [] }
    expect(flattenJsonApiResponse(body)).toEqual([])
  })

  // -- Single object data --

  it('should flatten a single object data response', () => {
    const body = {
      data: { id: '1', type: 'token', attributes: { name: 'ETH' } },
    }
    expect(flattenJsonApiResponse(body)).toEqual({
      id: '1',
      type: 'token',
      name: 'ETH',
    })
  })

  // -- No data key --

  it('should return body as-is when no data key is present', () => {
    const body = { status: 200, message: 'ok' }
    expect(flattenJsonApiResponse(body)).toEqual({
      status: 200,
      message: 'ok',
    })
  })

  // -- Null and primitive bodies --

  it('should return null when body is null', () => {
    expect(flattenJsonApiResponse(null)).toBeNull()
  })

  it('should return undefined when body is undefined', () => {
    expect(flattenJsonApiResponse(undefined)).toBeUndefined()
  })

  it('should return string body as-is', () => {
    expect(flattenJsonApiResponse('raw string')).toBe('raw string')
  })

  it('should return number body as-is', () => {
    expect(flattenJsonApiResponse(42)).toBe(42)
  })

  it('should return boolean body as-is', () => {
    expect(flattenJsonApiResponse(true)).toBe(true)
  })

  // -- Data is a primitive (not array, not object) --

  it('should return body as-is when data is a string', () => {
    const body = { data: 'some string' }
    expect(flattenJsonApiResponse(body)).toEqual({ data: 'some string' })
  })

  it('should return body as-is when data is a number', () => {
    const body = { data: 123 }
    expect(flattenJsonApiResponse(body)).toEqual({ data: 123 })
  })

  it('should return body as-is when data is null', () => {
    const body = { data: null }
    expect(flattenJsonApiResponse(body)).toEqual({ data: null })
  })

  // -- Complex scenarios --

  it('should flatten resources with multiple attributes in an array', () => {
    const body = {
      data: [
        {
          id: '10',
          type: 'project',
          attributes: {
            name: 'DeFi Protocol',
            chain: 'ethereum',
            momentum: 85.5,
          },
        },
      ],
    }
    expect(flattenJsonApiResponse(body)).toEqual([
      {
        id: '10',
        type: 'project',
        name: 'DeFi Protocol',
        chain: 'ethereum',
        momentum: 85.5,
      },
    ])
  })

  it('should ignore non-data envelope fields like meta and links', () => {
    const body = {
      data: [{ id: '1', type: 'x', attributes: { a: 1 } }],
      meta: { total: 100 },
      links: { next: '/page/2' },
    }
    const result = flattenJsonApiResponse(body)
    expect(result).toEqual([{ id: '1', type: 'x', a: 1 }])
  })

  it('should handle array body (no envelope) by returning as-is', () => {
    const body = [{ id: 1 }, { id: 2 }]
    expect(flattenJsonApiResponse(body)).toEqual([{ id: 1 }, { id: 2 }])
  })
})
