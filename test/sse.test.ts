import { describe, expect, it } from 'vitest';
import { SseParser, findResponse, matchResponse, parseSse } from '../src/sse.js';

describe('parseSse', () => {
  it('parses events separated by blank lines', () => {
    const events = parseSse('event: message\ndata: {"a":1}\n\ndata: second\n\n');
    expect(events).toEqual([
      { event: 'message', data: '{"a":1}' },
      { event: 'message', data: 'second' },
    ]);
  });

  it('joins multi-line data with newlines and strips one leading space', () => {
    expect(parseSse('data:  two spaces\ndata:none\n\n')[0]!.data).toBe(' two spaces\nnone');
  });

  it('ignores comments and unknown fields, keeps the last id', () => {
    const events = parseSse(': keep-alive\nretry: 1000\nfoo: bar\nid: 7\ndata: x\n\n');
    expect(events).toEqual([{ event: 'message', data: 'x', id: '7' }]);
  });

  it('handles CRLF and CR line endings', () => {
    expect(parseSse('data: a\r\n\r\ndata: b\r\rdata: c\n\n').map((e) => e.data)).toEqual(['a', 'b', 'c']);
  });

  it('does not dispatch an event without data', () => {
    expect(parseSse('event: ping\n\n')).toEqual([]);
  });

  it('dispatches a trailing event without the closing blank line at end of stream', () => {
    expect(parseSse('data: last').map((e) => e.data)).toEqual(['last']);
  });

  it('strips a BOM at the start of the stream', () => {
    expect(parseSse('﻿data: x\n\n')[0]!.data).toBe('x');
  });
});

describe('SseParser (chunked)', () => {
  it('produces the same events whatever the chunk boundaries', () => {
    const text = 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\ndata: tail\n\n';
    const whole = parseSse(text);
    for (let size = 1; size <= 7; size++) {
      const p = new SseParser();
      const got = [];
      for (let i = 0; i < text.length; i += size) got.push(...p.push(text.slice(i, i + size)));
      got.push(...p.end());
      expect(got).toEqual(whole);
    }
  });

  it('waits for the LF after a CR that ends a chunk', () => {
    const p = new SseParser();
    expect(p.push('data: a\r')).toEqual([]);
    expect(p.push('\n\r\n')).toEqual([{ event: 'message', data: 'a' }]);
  });
});

describe('matchResponse / findResponse', () => {
  it('picks the response whose id matches', () => {
    const events = parseSse(
      'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n' +
        'data: {"jsonrpc":"2.0","id":2,"result":{"x":2}}\n\n' +
        'data: {"jsonrpc":"2.0","id":1,"result":{"x":1}}\n\n',
    );
    const found = findResponse(events, 1);
    expect(found.response?.result).toEqual({ x: 1 });
    expect(found.others).toBe(2);
  });

  it('skips data that is not JSON', () => {
    const found = findResponse(parseSse('data: not json\n\ndata: {"jsonrpc":"2.0","id":"a","result":1}\n\n'), 'a');
    expect(found.response?.result).toBe(1);
    expect(found.others).toBe(1);
  });

  it('reads a response inside a batch', () => {
    expect(matchResponse([{ jsonrpc: '2.0', id: 3, result: 'r' }], 3)?.result).toBe('r');
  });

  it('accepts an error with a null id, not a result with a null id', () => {
    expect(matchResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 5)?.error?.code).toBe(-32700);
    expect(matchResponse({ jsonrpc: '2.0', id: null, result: {} }, 5)).toBeUndefined();
  });

  it('does not match a different id or a request', () => {
    expect(matchResponse({ jsonrpc: '2.0', id: 1, method: 'roots/list' }, 1)).toBeUndefined();
    expect(matchResponse({ jsonrpc: '2.0', id: '1', result: {} }, 1)).toBeUndefined();
  });
});
