import http from 'node:http';

interface TrafficConfig {
  baseUrl: string;
  intervalMs?: number;
  burstEveryN?: number;
}

export function startDemoTraffic(config: TrafficConfig = { baseUrl: 'http://127.0.0.1:8080' }) {
  let isRunning = true;
  let counter = 0;

  const routes = [
    { path: '/api/v1/users/101', tenant: 'acme', client: 'client_mobile_app' },
    { path: '/api/v1/users/202', tenant: 'acme', client: 'client_partner_portal' },
    { path: '/api/v1/search/items', tenant: 'acme', client: 'user_shopper_88' },
    { path: '/api/v1/checkout/pay', tenant: 'globex', client: 'client_pos_terminal' },
    { path: '/api/v1/export/report', tenant: 'globex', client: 'crawler_bot_misbehaving' },
    { path: '/api/v1/audit/logs', tenant: 'global', client: 'sec_scanner' }
  ];

  const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

  const sendRequest = (routeObj: typeof routes[0], burst = false) => {
    try {
      const parsedUrl = new URL(config.baseUrl);
      const req = http.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 8080,
          path: routeObj.path,
          method: 'GET',
          agent,
          headers: {
            'X-Tenant-ID': routeObj.tenant,
            'X-Client-ID': routeObj.client,
            'X-Forwarded-For': '127.0.0.1',
            ...(burst ? { 'Cost': '5' } : {})
          }
        },
        (res) => {
          res.resume(); // discard body
        }
      );
      req.on('error', () => {});
      req.end();
    } catch {
      // ignore
    }
  };

  const timer = setInterval(() => {
    if (!isRunning) return;
    counter++;

    // Pick random route
    const route = routes[Math.floor(Math.random() * routes.length)];
    sendRequest(route);

    // Occasional burst from misbehaving client to generate real 429 telemetry
    if (counter % (config.burstEveryN ?? 8) === 0) {
      const abusive = routes[4]; // crawler_bot_misbehaving
      for (let i = 0; i < 4; i++) {
        sendRequest(abusive, true);
      }
    }
  }, config.intervalMs ?? 150);

  const stop = () => {
    isRunning = false;
    clearInterval(timer);
    agent.destroy();
  };

  return { stop };
}

if (process.argv[1]?.endsWith('demo-traffic.ts')) {
  console.log('[traffic:demo] Starting live traffic generator against http://127.0.0.1:8080...');
  const { stop } = startDemoTraffic({ baseUrl: 'http://127.0.0.1:8080' });

  process.on('SIGINT', () => {
    console.log('\n[traffic:demo] Stopping traffic generator...');
    stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    stop();
    process.exit(0);
  });
}
