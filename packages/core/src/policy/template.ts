import type { Policy } from '../types.js';

export interface TemplateParam {
  name: string;
  type: 'string' | 'int' | 'integer' | 'duration' | 'bool' | 'boolean';
  required?: boolean;
  default?: string;
  description?: string;
}

export interface TemplateRecord {
  id: string;
  tenant: string;
  parameters: TemplateParam[];
  body: string; // JSON template string with {{param}} tokens
}

const PARAM_REGEX = /\{\{([a-zA-Z0-9_.-]+)\}\}/g;

export function instantiateTemplate(tmpl: TemplateRecord, params: Record<string, string>): Policy {
  const resolvedParams: Record<string, string> = {};

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

  let parsed: Policy;
  try {
    parsed = JSON.parse(rendered);
  } catch (err: any) {
    throw new Error(`failed to parse instantiated policy JSON from template "${tmpl.id}": ${err.message}`);
  }

  if (!parsed.tenant) {
    parsed.tenant = tmpl.tenant;
  }

  return parsed;
}

function validateParamType(name: string, val: string, type: string): void {
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
