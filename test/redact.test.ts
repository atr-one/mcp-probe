import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/redact.js';

describe('redactUrl', () => {
  it('masks the values of secret-looking query parameters and keeps the rest as written', () => {
    expect(redactUrl('https://mcp.example.com/mcp?api_key=sk-123&profile=dev%20box')).toBe('https://mcp.example.com/mcp?api_key=***&profile=dev%20box');
    expect(redactUrl('https://h.example/mcp?access_token=a&X-Amz-Signature=b&sessionId=c&mode=fast')).toBe('https://h.example/mcp?access_token=***&X-Amz-Signature=***&sessionId=***&mode=fast');
    expect(redactUrl('https://h.example/mcp?apiKey=a&PASSWORD=b&client_secret=c&auth=d')).toBe('https://h.example/mcp?apiKey=***&PASSWORD=***&client_secret=***&auth=***');
  });

  it('masks user info', () => {
    expect(redactUrl('https://user:pa55@h.example/mcp')).toBe('https://***:***@h.example/mcp');
  });

  it('leaves URLs without secrets, empty values and non-URLs alone', () => {
    expect(redactUrl('http://127.0.0.1:8765/mcp')).toBe('http://127.0.0.1:8765/mcp');
    expect(redactUrl('https://h.example/mcp?token=&flag')).toBe('https://h.example/mcp?token=&flag');
    expect(redactUrl('not a url')).toBe('not a url');
  });
});
