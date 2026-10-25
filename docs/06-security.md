# Security Audit & DDoS Defense

- **OWASP API4:2023 Defense**: Strictly enforces rate limits on unrestricted endpoints.
- **CIDR Subnet Masking**: Masks IPv4 to `/24` and IPv6 to `/64` to prevent botnets rotating single IP addresses from bypassing limits.
- **Header Injection Defense**: Strips client-supplied `X-RateLimit-*` headers before proxying upstream.
