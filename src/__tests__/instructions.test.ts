import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { KNOWMAN_SERVER_INSTRUCTIONS } from '../instructions';

describe('server instructions', () => {
  let client: Client;
  let transport: StdioClientTransport;

  beforeAll(async () => {
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['src/index.ts'],
      cwd: resolve(import.meta.dir, '../..'),
      env: {
        ...process.env,
        KNOWMAN_API_KEY: 'knm_test_key',
        KNOWMAN_API_URL: 'http://127.0.0.1:9',
      },
    });
    client = new Client({ name: 'instructions-test', version: '1.0.0' });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close();
  });

  it('returns the server instructions', () => {
    expect(client.getInstructions()).toBe(KNOWMAN_SERVER_INSTRUCTIONS);
  });

  it('keeps instructions within the length limit', () => {
    // Founder-specified text is 823 characters; limit raised from 700 on 2026-11-11.
    expect(KNOWMAN_SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(900);
  });
});
