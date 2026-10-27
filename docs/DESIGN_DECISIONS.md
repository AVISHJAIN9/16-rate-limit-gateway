# Design Decisions & Architectural Trade-offs: Distributed Rate Limiter Gateway

## Stack Selection
- **Core Technology**: `TypeScript (Express, Redis, Token Bucket)`
- **Rationale**: Low latency, lightweight memory footprint, and reliable concurrency handling.

## Architectural Trade-offs
1. **Asynchronous Non-blocking IO vs Thread-per-request**:
   - *Decision*: Asynchronous event-driven loops for all socket IO.
   - *Trade-off*: Event loop programming model requires strict avoidance of blocking operations in exchange for massive concurrent connection capacity.
2. **Graceful Fallbacks vs Hard Failures**:
   - *Decision*: In-memory cache or local storage fallbacks when external distributed components are unreachable.
   - *Trade-off*: Retains service availability during network blips while logging structured telemetry for operators.
