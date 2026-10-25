import * as fs from 'node:fs';
import * as path from 'node:path';
import YAML from 'yaml';
import { resolve12FactorEnv } from './secrets.js';
export function parseConfigBundle(filePath, envMap = process.env, secretsMap = {}, visitedFiles = new Set()) {
    const resolvedPath = path.resolve(filePath);
    if (visitedFiles.has(resolvedPath)) {
        throw new Error(`circular bundle include detected at "${resolvedPath}"`);
    }
    visitedFiles.add(resolvedPath);
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`bundle file not found: "${resolvedPath}"`);
    }
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const interpolated = resolve12FactorEnv(raw, envMap, secretsMap);
    const parsed = YAML.parse(interpolated);
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`invalid bundle format in "${resolvedPath}"`);
    }
    // Strict unknown fields check
    const allowedKeys = new Set(['version', 'env', 'includes', 'policies']);
    for (const k of Object.keys(parsed)) {
        if (!allowedKeys.has(k)) {
            throw new Error(`unknown field "${k}" in bundle "${resolvedPath}"`);
        }
    }
    const allPolicies = Array.isArray(parsed.policies) ? [...parsed.policies] : [];
    if (Array.isArray(parsed.includes)) {
        const baseDir = path.dirname(resolvedPath);
        for (const inc of parsed.includes) {
            const incPath = path.isAbsolute(inc) ? inc : path.join(baseDir, inc);
            const subBundle = parseConfigBundle(incPath, envMap, secretsMap, visitedFiles);
            allPolicies.push(...subBundle.policies);
        }
    }
    return {
        version: parsed.version ?? '1.0',
        env: parsed.env,
        includes: parsed.includes,
        policies: allPolicies,
    };
}
