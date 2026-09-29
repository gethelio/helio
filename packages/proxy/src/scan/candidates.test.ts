import { describe, it, expect } from 'vitest'
import { candidatesOf } from './candidates.js'
import { DEMO_TOOLS } from '../demo/corpus.js'

function props(properties: Record<string, unknown>): unknown {
  return { type: 'object', properties }
}

describe('candidatesOf', () => {
  it('finds exactly the two amount arguments of the demo corpus', () => {
    const hits = DEMO_TOOLS.flatMap((tool) =>
      candidatesOf(tool.inputSchema).map((c) => `${tool.name} ${c.kind} ${c.path}`),
    )
    expect(hits).toEqual(['create_charge amount $.amount', 'refund_charge amount $.amount'])
  })

  it('finds the echo server amounts by name and type and nothing on its other tools', () => {
    const echo = {
      send_email: props({ to: { type: 'string' }, body: { type: 'string' } }),
      create_payment: props({
        amount: { type: 'number', description: 'Payment amount in dollars' },
        currency: { type: 'string' },
        recipient: { type: 'string' },
      }),
      create_refund: props({ amount: { type: 'number' }, order_id: { type: 'string' } }),
      stripe_charge: props({ amount: { type: 'number' }, customer: { type: 'string' } }),
      paypal_payout: props({ total: { type: 'number' }, recipient: { type: 'string' } }),
    }
    expect(candidatesOf(echo.send_email)).toEqual([])
    expect(candidatesOf(echo.create_payment)).toEqual([
      { kind: 'amount', path: '$.amount', by: 'name' },
    ])
    expect(candidatesOf(echo.create_refund)).toEqual([
      { kind: 'amount', path: '$.amount', by: 'name' },
    ])
    expect(candidatesOf(echo.stripe_charge)).toEqual([
      { kind: 'amount', path: '$.amount', by: 'name' },
    ])
    expect(candidatesOf(echo.paypal_payout)).toEqual([
      { kind: 'amount', path: '$.total', by: 'name' },
    ])
  })

  it('reads a query string as SQL only when its description says sql', () => {
    expect(
      candidatesOf(props({ query: { type: 'string', description: 'The SQL query to run' } })),
    ).toEqual([{ kind: 'sql', path: '$.query', by: 'description' }])
    expect(candidatesOf(props({ query: { type: 'string', description: 'Search text' } }))).toEqual(
      [],
    )
    expect(candidatesOf(props({ query: { type: 'string', description: 'mysqldump' } }))).toEqual([])
    expect(candidatesOf(props({ statement: { type: 'string' } }))).toEqual([
      { kind: 'sql', path: '$.statement', by: 'name' },
    ])
    expect(candidatesOf(props({ raw_query: { type: 'string' } }))).toEqual([
      { kind: 'sql', path: '$.raw_query', by: 'name' },
    ])
  })

  it('walks nested objects three levels deep as dot-paths and stops there', () => {
    const nested = props({
      payment: props({ amount: { type: 'integer' }, url: { type: 'string' } }),
    })
    expect(candidatesOf(nested)).toEqual([
      { kind: 'amount', path: '$.payment.amount', by: 'name' },
      { kind: 'url', path: '$.payment.url', by: 'name' },
    ])
    const three = props({ a: props({ b: props({ amount: { type: 'number' } }) }) })
    expect(candidatesOf(three)).toEqual([{ kind: 'amount', path: '$.a.b.amount', by: 'name' }])
    const deep = props({ a: props({ b: props({ c: props({ amount: { type: 'number' } }) }) }) })
    expect(candidatesOf(deep)).toEqual([])
  })

  it('emits an array of strings under a path name as the array itself and never walks elements', () => {
    // The official filesystem server: read_multiple_files, move_file.
    expect(candidatesOf(props({ paths: { type: 'array', items: { type: 'string' } } }))).toEqual([
      { kind: 'path', path: '$.paths', by: 'name' },
    ])
    expect(
      candidatesOf(props({ source: { type: 'string' }, destination: { type: 'string' } })),
    ).toEqual([
      { kind: 'path', path: '$.source', by: 'name' },
      { kind: 'path', path: '$.destination', by: 'name' },
    ])
    expect(
      candidatesOf(props({ files: { type: 'array', items: { type: ['string', 'null'] } } })),
    ).toEqual([{ kind: 'path', path: '$.files', by: 'name' }])
    // GitHub push_files: an array of { path, content } objects is the named miss.
    expect(
      candidatesOf(
        props({
          files: {
            type: 'array',
            items: props({ path: { type: 'string' }, content: { type: 'string' } }),
          },
        }),
      ),
    ).toEqual([])
  })

  it('requires the type to match the kind, a type list counting if any member qualifies', () => {
    expect(candidatesOf(props({ amount: { type: 'string' } }))).toEqual([])
    expect(candidatesOf(props({ total: { type: ['number', 'null'] } }))).toEqual([
      { kind: 'amount', path: '$.total', by: 'name' },
    ])
    expect(candidatesOf(props({ amount: {} }))).toEqual([])
    expect(candidatesOf(props({ payment: props({ x: { type: 'number' } }) }))).toEqual([])
  })

  it('admits format uri only on a string-typed property', () => {
    expect(candidatesOf(props({ id: { type: 'integer', format: 'uri' } }))).toEqual([])
    expect(candidatesOf(props({ id: { format: 'uri' } }))).toEqual([])
    expect(candidatesOf(props({ id: { type: ['string', 'null'], format: 'uri' } }))).toEqual([
      { kind: 'url', path: '$.id', by: 'format' },
    ])
  })

  it('reads format uri or url as a URL whatever the name, and target is not a path', () => {
    expect(candidatesOf(props({ target: { type: 'string', format: 'uri' } }))).toEqual([
      { kind: 'url', path: '$.target', by: 'format' },
    ])
    expect(candidatesOf(props({ site: { type: 'string', format: 'url' } }))).toEqual([
      { kind: 'url', path: '$.site', by: 'format' },
    ])
    expect(candidatesOf(props({ href: { type: 'string', format: 'uri' } }))).toEqual([
      { kind: 'url', path: '$.href', by: 'name' },
    ])
    expect(candidatesOf(props({ target: { type: 'string' } }))).toEqual([])
  })

  it('matches names as whole underscore-delimited words, case-insensitively', () => {
    expect(candidatesOf(props({ total_amount: { type: 'number' } }))).toEqual([
      { kind: 'amount', path: '$.total_amount', by: 'name' },
    ])
    expect(candidatesOf(props({ Amount: { type: 'integer' } }))).toEqual([
      { kind: 'amount', path: '$.Amount', by: 'name' },
    ])
    expect(candidatesOf(props({ amounts: { type: 'number' } }))).toEqual([])
    expect(candidatesOf(props({ fee: { type: 'number' }, qty: { type: 'integer' } }))).toEqual([
      { kind: 'amount', path: '$.fee', by: 'name' },
      { kind: 'amount', path: '$.qty', by: 'name' },
    ])
    expect(candidatesOf(props({ webhook: { type: 'string' }, cwd: { type: 'string' } }))).toEqual([
      { kind: 'url', path: '$.webhook', by: 'name' },
      { kind: 'path', path: '$.cwd', by: 'name' },
    ])
  })

  it('yields nothing for a missing or non-object schema', () => {
    expect(candidatesOf(undefined)).toEqual([])
    expect(candidatesOf('x')).toEqual([])
    expect(candidatesOf({ type: 'object' })).toEqual([])
    expect(candidatesOf({ type: 'object', properties: 'nope' })).toEqual([])
    expect(candidatesOf({ type: 'object', properties: { amount: 'number' } })).toEqual([])
  })
})
