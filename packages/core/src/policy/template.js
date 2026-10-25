const PARAM_REGEX = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;
export function instantiateTemplate(tmpl, params) {
    const resolvedParams = {};
    for (const p of tmpl.parameters) {
        let val = params[p.name];
        if (val === undefined || val.trim() === '') {
            if (p.required) {
                throw new Error(`missing required template parameter "${p.name}"`);
            }
            val = p.default ?? '';
        }
        if (val !== '') {
            validateParamType(p.name, val, p.type);
        }
        resolvedParams[p.name] = val;
    }
    // Token substitution
    const rendered = tmpl.body.replace(PARAM_REGEX, (_match, token) => {
        const val = resolvedParams[token];
        if (val === undefined) {
            throw new Error(`unresolved template token "${token}" in body`);
        }
        return val;
    });
    let parsed;
    try {
        parsed = JSON.parse(rendered);
    }
    catch (err) {
        throw new Error(`failed to parse instantiated policy JSON from template "${tmpl.id}": ${err.message}`);
    }
    if (!parsed.tenant) {
        parsed.tenant = tmpl.tenant;
    }
    return parsed;
}
function validateParamType(name, val, type) {
    switch (type.toLowerCase()) {
        case 'int':
        case 'integer': {
            const num = parseInt(val, 10);
            if (isNaN(num)) {
                throw new Error(`parameter "${name}" value "${val}" is not a valid integer`);
            }
            break;
        }
        case 'bool':
        case 'boolean': {
            if (val !== 'true' && val !== 'false') {
                throw new Error(`parameter "${name}" value "${val}" is not a valid boolean`);
            }
            break;
        }
        case 'duration': {
            // Must match e.g. 100ms, 1s, 5m, 1h
            if (!/^\d+(ms|s|m|h)$/.test(val)) {
                throw new Error(`parameter "${name}" value "${val}" is not a valid duration`);
            }
            break;
        }
        case 'string':
        default:
            break;
    }
}
