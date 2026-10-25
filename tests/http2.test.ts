import { describe, it, expect, afterEach } from 'vitest';
import http2 from 'node:http2';
import http from 'node:http';
import { GatewayServer } from '../apps/gateway/src/server.js';
import type { GatewayConfig } from '@rlgw/core';

describe('F72: HTTP/2 Gateway Serving and Proxying', () => {
  let gateway: GatewayServer | undefined;
  let upstream: http.Server | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop(100);
      gateway = undefined;
    }
    if (upstream) {
      upstream.close();
      upstream = undefined;
    }
  });

  it('serves requests and proxies to upstream via HTTP/2', async () => {
    // 1. Create upstream server
    const upstreamPort = await new Promise<number>((resolve) => {
      upstream = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'hello from upstream' }));
      });
      upstream.listen(0, '127.0.0.1', () => {
        resolve((upstream!.address() as any).port);
      });
    });

    const config: GatewayConfig = {
      version: '1.0',
      dataListener: {
        port: 0,
        host: '127.0.0.1',
        headersTimeout: 5000,
        requestTimeout: 15000,
        keepAliveTimeout: 60000,
        maxHeaderSize: 16384,
        maxRequestsPerSocket: 1000,
        http2: true
      },
      adminListener: {
        port: 0,
        host: '127.0.0.1',
        headersTimeout: 5000,
        requestTimeout: 15000,
        keepAliveTimeout: 60000,
        maxHeaderSize: 16384,
        maxRequestsPerSocket: 1000,
        http2: false
      },
      upstreams: [
        {
          pathPrefix: '/api',
          strategy: 'round-robin',
          timeoutMs: 5000,
          targets: [{ url: `http://127.0.0.1:${upstreamPort}`, weight: 1 }]
        }
      ],
      store: { type: 'memory' },
      policySource: { type: 'memory', watch: false },
      failMode: 'fail_open',
      trust: {
        trustedProxies: ['127.0.0.1'],
        trustForwardedHeaders: false,
        clientIpHeader: 'X-Forwarded-For'
      },
      adminAuth: { type: 'static_token', staticToken: 'test-token' },
      observability: { logLevel: 'info', decisionLogBufferCapacity: 1000, sampleRate: 1 }
    };

    gateway = new GatewayServer(config);
    const { dataPort } = await gateway.start();

    // 2. Connect via HTTP/2 client
    const client = http2.connect(`http://127.0.0.1:${dataPort}`);

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = client.request({
        ':path': '/api/hello',
        ':method': 'GET'
      });

      let data = '';
      req.on('response', (headers) => {
        const status = Number(headers[':status']);
        req.on('data', (chunk) => {
          data += chunk;
        });
        req.on('end', () => {
          resolve({ status, body: data });
        });
      });
      req.on('error', reject);
      req.end();
    });

    expect(response.status).toBe(200);
    const json = JSON.parse(response.body);
    expect(json.message).toBe('hello from upstream');

    client.close();
  });
});
