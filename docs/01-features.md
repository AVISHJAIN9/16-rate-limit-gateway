# Feature Inventory & Architectural Traces

## F1: Multi-Algorithm Rate Limiting Engine

### Technical Description
Supports five interchangeable algorithms per route:
1. **Token Bucket**: Replenishes tokens at a fixed rate up to capacity; permits bursts.
2. **Leaky Bucket**: Queues and leaks requests at constant speed; smooths traffic.
3. **Fixed Window**: Counters reset at clock boundaries; simple but vulnerable to 2x boundary bursts.
4. **Sliding Window Log**: Stores sorted timestamps; perfectly accurate but $O(N)$ memory.
5. **Sliding Window Counter**: Interpolates between current and previous window counts; $O(1)$ memory with <0.1% boundary error.

- **Primary Source**: `src/algorithms/`
- **Complexity**: $O(1)$ time and memory for Token Bucket and Sliding Window Counter.

### Say It Out Loud
> "I implemented five distinct rate limiting algorithms to allow fine-tuned protection across different API endpoints. For burst-tolerant endpoints like login submissions, we use Token Bucket, which allows momentary bursts up to capacity while enforcing a strict steady-state refill rate. For expensive database reports, we use Leaky Bucket to smooth traffic into a continuous, uniform stream. For standard REST APIs, we default to Sliding Window Counter: it weights request counts from the previous and current window, eliminating the classic double-burst vulnerability of fixed windows while using constant O(1) memory."

---

## F2: Atomic Redis Lua Script Pipeline & In-Memory Fallback

### Technical Description
Executes rate limit state checks, refills, decrements, and TTL updates in a single atomic Lua script executed inside Redis. If Redis fails or times out (50ms limit), the storage layer seamlessly falls back to an in-memory store.

- **Primary Source**: `packages/store-redis/`, `packages/store-memory/`
- **Race Condition Immunity**: Guarantees zero over-allocation across hundreds of concurrent gateway replicas.

### Say It Out Loud
> "To prevent race conditions in a distributed cluster, I executed all rate-limit evaluations via atomic Lua scripts directly on the Redis server. Without Lua, checking a client's quota and then decrementing it requires multiple round-trips; under high concurrency, fifty requests can all read 'count=99' and pass through before any write occurs. Our Lua script evaluates the token balance, calculates replenishment based on elapsed time, deducts the token cost, and sets the TTL atomically in a single network hop. Furthermore, I built a circuit breaker on the Redis client: if Redis becomes unreachable, the gateway degrades to an in-memory fallback within 50 milliseconds, ensuring zero service disruption."

---

## F3: Client Identity, Scopes & Dynamic Route Costs

### Technical Description
Resolves client identity using a prioritized cascade: Bearer JWT claims -> API Key -> IP Subnet (CIDR /24 mask). Evaluates route costs dynamically based on HTTP method, payload size, and query parameters.

- **Primary Source**: `src/identity/`, `src/policy/rule.py`
