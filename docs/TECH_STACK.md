# Technology Stack Specification: Distributed Rate Limiter Gateway

| Layer | Component | Selection | Rationale |
| :--- | :--- | :--- | :--- |
| **Service Engine** | Backend Runtime | TypeScript (Express, Redis, Token Bucket) | High concurrency, predictable resource utilization, and asynchronous IO |
| **Governance** | CI & Automation | GitHub Actions | Automated linting, build checks, and Dependabot dependency updates |
| **Documentation** | System Specs | Markdown & Mermaid | Living documentation versioned directly alongside application code |
