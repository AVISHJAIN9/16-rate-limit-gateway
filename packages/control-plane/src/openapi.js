import fs from 'node:fs';
import path from 'node:path';
export const OPENAPI_SPEC = {
    openapi: '3.0.3',
    info: {
        title: 'Rate-Limit Gateway (RLGW) Control Plane API',
        version: '1.0.0',
        description: 'High-performance distributed rate-limiting gateway admin and management API.'
    },
    servers: [
        {
            url: 'http://localhost:8081',
            description: 'Local Admin Server'
        }
    ],
    paths: {
        '/healthz': {
            get: {
                summary: 'Liveness probe',
                responses: {
                    '200': { description: 'Healthy' },
                    '503': { description: 'Unhealthy (event loop delay excessive)' }
                }
            }
        },
        '/readyz': {
            get: {
                summary: 'Readiness probe',
                responses: {
                    '200': { description: 'Ready and policies loaded' },
                    '503': { description: 'Draining or policies not ready' }
                }
            }
        },
        '/metrics': {
            get: {
                summary: 'Prometheus metrics scrape endpoint',
                responses: {
                    '200': { description: 'Prometheus metrics' }
                }
            }
        },
        '/admin/v1/snapshot': {
            get: {
                summary: 'Current loaded policy snapshot metadata and hash',
                responses: {
                    '200': { description: 'Current snapshot' }
                }
            }
        },
        '/admin/v1/reload': {
            post: {
                summary: 'Trigger dynamic zero-downtime policy reload',
                responses: {
                    '200': { description: 'Policies reloaded' }
                }
            }
        },
        '/admin/v1/policies': {
            get: {
                summary: 'List policies with pagination and tenant filter',
                responses: {
                    '200': { description: 'List of policies' }
                }
            },
            post: {
                summary: 'Create a new policy',
                responses: {
                    '201': { description: 'Policy created' }
                }
            }
        },
        '/admin/v1/policies/{id}': {
            get: {
                summary: 'Get policy details by ID',
                responses: {
                    '200': { description: 'Policy details' },
                    '404': { description: 'Policy not found' }
                }
            },
            delete: {
                summary: 'Delete a policy',
                responses: {
                    '200': { description: 'Policy deleted' }
                }
            }
        },
        '/admin/v1/policies/{id}/diff': {
            get: {
                summary: 'Get semantic field-level diff between policy versions',
                responses: {
                    '200': { description: 'Policy diff report' }
                }
            }
        },
        '/admin/v1/counters': {
            get: {
                summary: 'Inspect live counter state via non-destructive peek',
                responses: {
                    '200': { description: 'Current counter state' }
                }
            }
        },
        '/admin/v1/evaluate': {
            post: {
                summary: 'Semantic dry-run simulation of policies against virtual clock',
                responses: {
                    '200': { description: 'Simulation results' }
                }
            }
        },
        '/admin/v1/validate': {
            post: {
                summary: 'Syntax validation against Zod schema',
                responses: {
                    '200': { description: 'Validation outcome' }
                }
            }
        },
        '/admin/v1/quotas/import': {
            post: {
                summary: 'Bulk import tenant quotas with validation report',
                responses: {
                    '200': { description: 'Validation and import outcome' }
                }
            }
        },
        '/admin/v1/quotas/export': {
            get: {
                summary: 'Bulk export tenant quotas as JSON or CSV',
                responses: {
                    '200': { description: 'Exported quotas' }
                }
            }
        },
        '/admin/v1/overrides': {
            post: {
                summary: 'Apply TTL-bound dynamic quota override with relaxation guardrail',
                responses: {
                    '200': { description: 'Override applied' }
                }
            }
        },
        '/admin/v1/allowlist': {
            post: {
                summary: 'Add temporary emergency allowlist entry',
                responses: {
                    '200': { description: 'Allowlist entry created' }
                }
            }
        },
        '/admin/v1/blacklist': {
            post: {
                summary: 'Add dynamic client blacklist entry',
                responses: {
                    '200': { description: 'Blacklist entry created' }
                }
            }
        },
        '/admin/v1/loglevel': {
            post: {
                summary: 'Adjust runtime log level with optional auto-revert timer',
                responses: {
                    '200': { description: 'Log level adjusted' }
                }
            }
        }
    }
};
export function writeOpenApiSpec(outputPath) {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(outputPath, JSON.stringify(OPENAPI_SPEC, null, 2), 'utf-8');
}
