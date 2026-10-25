# Complete API Reference

### 1. Gateway Forwarding Proxy
- **Path**: `/*` (All forwarded microservice endpoints)
- **Rate Limit Response Headers**:
  - `X-RateLimit-Limit`: Maximum quota allowed in current window.
  - `X-RateLimit-Remaining`: Remaining request tokens.
  - `X-RateLimit-Reset`: Unix timestamp when quota fully resets.
  - `Retry-After`: Seconds to wait before retrying (on HTTP 429).

### 2. Admin Policy Management
- **Method**: `GET /admin/policies` (List active rules)
- **Method**: `POST /admin/policies` (Hot-reload rule configuration)
- **Method**: `GET /health` (Gateway & Redis connection status)
