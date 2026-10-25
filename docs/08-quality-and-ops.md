# Quality Engineering & Testing

- **Vitest Suite**: 25 test suites passing unit, property, and end-to-end gateway scenarios.
- **Property-based Testing**: Uses `fast-check` to verify that sliding window counts never exceed limits under arbitrary timestamp interleaving.
- **Graceful Shutdown**: Drains in-flight proxied requests before terminating gateway workers.
