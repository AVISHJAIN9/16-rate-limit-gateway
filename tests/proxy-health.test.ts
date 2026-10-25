import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { StreamingReverseProxy } from '../apps/gateway/src/proxy.js';

describe('F63 & F64/F65: Least Connections & Active Health Probing', () => {
  const servers: http.Server[] = [];

  const createServer = (handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{ server: http.Server; port: number }> => {
    return new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        servers.push(server);
        resolve({ server, port: addr.port });
      });
    });
  };

  afterEach(() => {
    for (const s of servers) {
      s.close();
    }
    servers.length = 0;
  });

  it('selects least loaded target when strategy is least-connections', async () => {
    const s1 = await createServer((_req, res) => {
      res.writeHead(200);
      res.end('server 1');
    });
    const s2 = await createServer((_req, res) => {
      res.writeHead(200);
      res.end('server 2');
    });

    const proxy = new StreamingReverseProxy({
      autoStartHealthChecks: false,
      routes: [
        {
          pathPrefix: '/api',
          strategy: 'least-connections',
          timeoutMs: 2000,
          targets: [
            { url: `http://127.0.0.1:${s1.port}`, weight: 1 },
            { url: `http://127.0.0.1:${s2.port}`, weight: 1 }
          ]
        }
      ]
    });

    const route = proxy.findRoute('/api/test')!;
    expect(route).toBeDefined();

    // Initially both inFlight = 0
    const t1 = proxy.selectTarget(route);
    // Now s1 inFlight = 1, s2 inFlight = 0
    expect(proxy.getTargetState(`http://127.0.0.1:${s1.port}`)?.inFlight).toBe(1);
    expect(proxy.getTargetState(`http://127.0.0.1:${s2.port}`)?.inFlight).toBe(0);

    // Next selection MUST pick s2 because it has 0 inFlight vs 1
    const t2 = proxy.selectTarget(route);
    expect(t2.targetUrl.port).toBe(String(s2.port));
    expect(proxy.getTargetState(`http://127.0.0.1:${s2.port}`)?.inFlight).toBe(1);

    // Release t1
    t1.release();
    expect(proxy.getTargetState(`http://127.0.0.1:${s1.port}`)?.inFlight).toBe(0);

    // Now s1 has 0 inFlight, s2 has 1 -> next pick should be s1
    const t3 = proxy.selectTarget(route);
    expect(t3.targetUrl.port).toBe(String(s1.port));

    t2.release();
    t3.release();
    proxy.close();
  });

  it('performs active health probes and marks unhealthy/healthy based on thresholds', async () => {
    let s1Healthy = true;
    const s1 = await createServer((_req, res) => {
      if (s1Healthy) {
        res.writeHead(200);
        res.end('OK');
      } else {
        res.writeHead(500);
        res.end('ERROR');
      }
    });

    const proxy = new StreamingReverseProxy({
      autoStartHealthChecks: false,
      routes: [
        {
          pathPrefix: '/service',
          strategy: 'least-connections',
          timeoutMs: 1000,
          targets: [{ url: `http://127.0.0.1:${s1.port}`, weight: 1 }],
          healthCheck: {
            path: '/healthz',
            intervalMs: 100,
            timeoutMs: 500,
            unhealthyThreshold: 2,
            healthyThreshold: 2
          }
        }
      ]
    });

    const route = proxy.findRoute('/service')!;
    const state = proxy.getTargetState(`http://127.0.0.1:${s1.port}`)!;
    expect(state.healthy).toBe(true);

    // Probe 1: success
    await proxy.executeProbeRound(route);
    expect(state.consecutiveSuccesses).toBe(1);
    expect(state.healthy).toBe(true);

    // Make server return 500
    s1Healthy = false;

    // Fail 1: below threshold 2
    await proxy.executeProbeRound(route);
    expect(state.consecutiveFailures).toBe(1);
    expect(state.healthy).toBe(true);

    // Fail 2: reaches unhealthyThreshold 2 -> transition to unhealthy!
    await proxy.executeProbeRound(route);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.healthy).toBe(false);

    // Recover server
    s1Healthy = true;

    // Success 1: below healthyThreshold 2 -> remains unhealthy
    await proxy.executeProbeRound(route);
    expect(state.consecutiveSuccesses).toBe(1);
    expect(state.healthy).toBe(false);

    // Success 2: reaches healthyThreshold 2 -> transitions back to healthy!
    await proxy.executeProbeRound(route);
    expect(state.consecutiveSuccesses).toBe(2);
    expect(state.healthy).toBe(true);

    proxy.close();
  });
});
