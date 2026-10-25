const ENV_VAR_REGEX = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::([^}]*))?\}/g;
const SECRET_REF_REGEX = /\$\{secret:([a-zA-Z0-9_.-]+)\}/g;
export function resolve12FactorEnv(input, envMap = process.env, secretsMap = {}) {
    // 1. Resolve secrets ${secret:KEY}
    let output = input.replace(SECRET_REF_REGEX, (_match, key) => {
        const val = secretsMap[key];
        if (val === undefined) {
            throw new Error(`unresolved secret reference "${key}"`);
        }
        return val;
    });
    // 2. Resolve environment variables ${VAR:-default}
    output = output.replace(ENV_VAR_REGEX, (_match, varName, defaultVal) => {
        const val = envMap[varName];
        if (val !== undefined && val !== '') {
            return val;
        }
        if (defaultVal !== undefined) {
            return defaultVal;
        }
        throw new Error(`unresolved environment variable "${varName}" with no default`);
    });
    return output;
}
