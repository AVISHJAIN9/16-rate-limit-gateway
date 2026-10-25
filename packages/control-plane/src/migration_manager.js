import { PolicySchema } from '@rlgw/core';
export class PolicyMigrationManager {
    steps = [
        {
            version: 2,
            description: 'Ensure failMode is explicitly defined and default to fail_closed if missing',
            up: (policy) => {
                const migrated = { ...policy };
                if (!migrated.failMode) {
                    migrated.failMode = 'fail_closed';
                }
                return migrated;
            },
            down: (policy) => {
                const reverted = { ...policy };
                delete reverted.failMode;
                return reverted;
            }
        },
        {
            version: 3,
            description: 'Migrate legacy burst params if nested differently',
            up: (policy) => {
                const migrated = { ...policy };
                if (migrated.params && migrated.params.type === 'token_bucket' && migrated.params.burst === undefined) {
                    migrated.params.burst = migrated.params.capacity;
                }
                return migrated;
            },
            down: (policy) => {
                return policy;
            }
        }
    ];
    migrate(policy, targetVersion, dryRun = false) {
        let current = JSON.parse(JSON.stringify(policy));
        const applied = [];
        const sortedSteps = [...this.steps].sort((a, b) => a.version - b.version);
        for (const step of sortedSteps) {
            if (step.version <= targetVersion) {
                current = step.up(current);
                applied.push(step.version);
            }
        }
        // Validate against current PolicySchema
        PolicySchema.parse(current);
        return {
            migrated: current,
            appliedVersions: applied,
            dryRun
        };
    }
    rollback(policy, fromVersion, toVersion) {
        let current = JSON.parse(JSON.stringify(policy));
        const sortedSteps = [...this.steps].filter((s) => s.version <= fromVersion && s.version > toVersion).sort((a, b) => b.version - a.version);
        for (const step of sortedSteps) {
            current = step.down(current);
        }
        return current;
    }
}
