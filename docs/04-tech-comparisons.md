# Technology Choices & Exhaustive Comparisons

## Rate Limiting Storage: Redis vs Memcached vs DynamoDB vs Local Memory

| Factor | Redis (Chosen) | Memcached | DynamoDB | In-Memory Only |
| :--- | :--- | :--- | :--- | :--- |
| **Atomic Programmability** | **Lua Scripts (Complex Multi-Key Logic)** | CAS (Compare-And-Swap only) | Conditional Writes (High Latency) | Atomic Variables |
| **Distributed Accuracy** | **100% Shared Across Clustered Gateways** | 100% Shared | 100% Shared | Per-Node Only (Inaccurate) |
| **Read/Write Latency** | **Sub-millisecond (in-memory)** | Sub-millisecond | 5-15ms (Network + Disk) | Nanoseconds |
| **Cost at Scale** | Moderate | Moderate | Expensive per write request | Free |

- **Why Redis**: Supports server-side Lua execution, allowing atomic sliding window calculation in a single network round trip.
