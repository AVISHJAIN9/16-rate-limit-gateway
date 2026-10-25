---
layout: home

hero:
  name: "16-Rate-Limit-Gateway"
  text: "Distributed Multi-Algorithm Rate Limiting API Gateway"
  tagline: "Atomic Redis Lua scripts, 5 interchangeable algorithms, sub-millisecond evaluation, and circuit-breaker in-memory fallback."
  actions:
    - theme: brand
      text: Project Overview
      link: /00a-project-analysis
    - theme: alt
      text: 2-Minute Pitch
      link: /00b-project-pitch
    - theme: alt
      text: System Design
      link: /system-design/

features:
  - title: "F1: Multi-Algorithm Engine"
    details: "Supports Token Bucket, Leaky Bucket, Fixed Window, Sliding Window Log, and Sliding Window Counter."
    link: /features/F1-multi-algorithm-engine
  - title: "F2: Atomic Redis Lua Scripts"
    details: "Executes quota evaluations atomically inside Redis, eliminating distributed race conditions and double-bursts."
    link: /features/F2-atomic-redis-lua
  - title: "F3: Client Identity & Scopes"
    details: "Prioritized client extraction from JWT claims, API keys, and CIDR subnet masking with dynamic route cost resolvers."
    link: /features/F3-client-identity-scopes
  - title: "F4: Dynamic Policy Engine"
    details: "Runtime policy hot-reloading from YAML and JSON without requiring gateway process restarts."
    link: /features/F4-policy-matcher-hot-reload
  - title: "F5: Real-time Web Console"
    details: "React 19 admin dashboard displaying real-time quota consumption and worker health."
    link: /features/F5-realtime-web-console
  - title: "High-Scale Systems Architecture"
    details: "Capacity estimation and resilience modeling for 100,000 requests/second with sub-millisecond overhead."
    link: /system-design/14.1-requirements-and-estimation
---
