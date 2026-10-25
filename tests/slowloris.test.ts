import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { GatewayServer } from '../apps/gateway/src/server.js';
import type { GatewayConfig } from '@rlgw/core';

describe('F85: Slowloris & Per-IP Concurrency Protection', () => {
  let gateway: GatewayServer | undefined;

  afterEach(async () => {
    if (gateway) {
      await gateway.stop(100);
      gateway = undefined;
    }
  });

  it('rejects connections beyond maxConnectionsPerIp', async () => {
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
        http2: false,
        maxConnectionsPerIp: 3
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
      upstreams: [],
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

    const sockets: net.Socket[] = [];
    const openSocket = (): Promise<boolean> => {
      return new Promise((resolve) => {
        const s = net.connect(dataPort, '127.0.0.1', () => {
          sockets.push(s);
          resolve(true);
        });
        s.on('error', () => resolve(false));
        s.on('close', () => resolve(false));
      });
    };

    // Open 3 connections (should succeed)
    const s1 = await openSocket();
    const s2 = await openSocket();
    const s3 = await openSocket();
    expect(s1).toBe(true);
    expect(s2).toBe(true);
    expect(s3).toBe(true);

    // 4th connection from same IP (127.0.0.1) exceeds maxConnectionsPerIp = 3
    const fourthSocketClosed = await new Promise<boolean>((resolve) => {
      const s4 = net.connect(dataPort, '127.0.0.1', () => {
        // Socket may connect initially at TCP level, but gateway destroys it immediately
      });
      s4.on('close', () => resolve(true));
      s4.on('error', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    expect(fourthSocketClosed).toBe(true);

    for (const s of sockets) {
      s.destroy();
    }
  });
});
