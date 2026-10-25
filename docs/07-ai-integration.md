# AI Integration: Adaptive Anomaly Detection

- **Anomaly Oracle (`packages/oracle/`)**: Calculates traffic anomaly scores; dynamically adjusts token bucket refill rates for suspicious client fingerprints.
- **Pre-trained Explainer**: Connects to pre-trained LLM API to generate human-readable explanations: *"Client 192.168.1.5 was throttled due to 450 POST requests in 30 seconds"*.
