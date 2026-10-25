let inMemoryToken = null;
let unauthorizedHandler = null;
export function setToken(token) {
    inMemoryToken = token;
}
export function getToken() {
    return inMemoryToken;
}
export function onUnauthorized(handler) {
    unauthorizedHandler = handler;
}
async function request(endpoint, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Content-Type', 'application/json');
    if (inMemoryToken) {
        headers.set('Authorization', `Bearer ${inMemoryToken}`);
    }
    const response = await fetch(endpoint, {
        ...options,
        headers
    });
    if (response.status === 401) {
        inMemoryToken = null;
        if (unauthorizedHandler) {
            unauthorizedHandler();
        }
        throw new Error('Unauthorized');
    }
    if (response.status === 304) {
        return { data: null, etag: response.headers.get('ETag') ?? undefined };
    }
    if (!response.ok) {
        let errMessage = `HTTP error ${response.status}`;
        try {
            const errJson = await response.json();
            errMessage = errJson.error || errJson.message || errMessage;
        }
        catch {
            // Ignore
        }
        throw new Error(errMessage);
    }
    const data = (await response.json());
    const etag = response.headers.get('ETag') ?? undefined;
    return { data, etag };
}
export const api = {
    login: async (creds) => {
        const res = await request('/admin/v1/auth/login', {
            method: 'POST',
            body: JSON.stringify(creds)
        });
        setToken(res.data.token);
        return res.data;
    },
    getMe: async () => {
        const res = await request('/admin/v1/me');
        return res.data.user;
    },
    getOverview: async () => {
        const res = await request('/admin/v1/overview');
        return res.data;
    },
    getPolicies: async (params = {}) => {
        const query = new URLSearchParams();
        if (params.tenant)
            query.set('tenant', params.tenant);
        if (params.search)
            query.set('search', params.search);
        if (params.algorithm)
            query.set('algorithm', params.algorithm);
        if (params.page)
            query.set('page', String(params.page));
        if (params.limit)
            query.set('limit', String(params.limit));
        const url = `/admin/v1/policies?${query.toString()}`;
        const res = await request(url);
        return { ...res.data, etag: res.etag };
    },
    getPolicy: async (id) => {
        const res = await request(`/admin/v1/policies/${id}`);
        return res.data;
    },
    createPolicy: async (policy, reason) => {
        const res = await request('/admin/v1/policies', {
            method: 'POST',
            body: JSON.stringify({ ...policy, reason })
        });
        return res.data;
    },
    updatePolicy: async (id, policy, etag, reason) => {
        const headers = {};
        if (etag)
            headers['If-Match'] = etag;
        const res = await request(`/admin/v1/policies/${id}`, {
            method: 'PUT',
            headers,
            body: JSON.stringify({ ...policy, reason })
        });
        return res.data;
    },
    deletePolicy: async (id) => {
        const res = await request(`/admin/v1/policies/${id}`, {
            method: 'DELETE'
        });
        return res.data;
    },
    getPolicyVersions: async (id) => {
        const res = await request(`/admin/v1/policies/${id}/versions`);
        return res.data.versions;
    },
    activateVersion: async (id, version) => {
        const res = await request(`/admin/v1/policies/${id}/activate`, {
            method: 'POST',
            body: JSON.stringify({ version })
        });
        return res.data;
    },
    rollbackVersion: async (id, version) => {
        const res = await request(`/admin/v1/policies/${id}/rollback`, {
            method: 'POST',
            body: JSON.stringify({ version })
        });
        return res.data;
    },
    getPolicyDiff: async (id, from, to) => {
        const res = await request(`/admin/v1/policies/${id}/diff?from=${from}&to=${to}`);
        return res.data.diff;
    },
    validatePolicy: async (policy) => {
        const res = await request('/admin/v1/validate', {
            method: 'POST',
            body: JSON.stringify(policy)
        });
        return res.data;
    },
    evaluatePolicy: async (policy, requests) => {
        const res = await request('/admin/v1/evaluate', {
            method: 'POST',
            body: JSON.stringify({ policy, requests })
        });
        return res.data.results;
    },
    getClientLookup: async (id, tenant) => {
        const q = tenant ? `?tenant=${tenant}` : '';
        const res = await request(`/admin/v1/clients/${id}${q}`);
        return res.data;
    },
    getTenantLookup: async (id) => {
        const res = await request(`/admin/v1/tenants/${id}`);
        return res.data;
    },
    getRouteLookup: async (id) => {
        const res = await request(`/admin/v1/routes/${encodeURIComponent(id)}`);
        return res.data;
    },
    getTimeseries: async () => {
        const res = await request('/admin/v1/timeseries');
        return res.data.points;
    },
    getTopClients: async (tenant) => {
        const q = tenant ? `?tenant=${tenant}` : '';
        const res = await request(`/admin/v1/top/clients${q}`);
        return res.data.topClients;
    },
    getAnalyticsUtilization: async () => {
        const res = await request('/admin/v1/analytics/utilization');
        return res.data.utilization;
    },
    getAnalyticsRejections: async (tenant) => {
        const q = tenant ? `?tenant=${tenant}` : '';
        const res = await request(`/admin/v1/analytics/rejections${q}`);
        return res.data.reasons;
    },
    getAnalyticsRetryAfter: async () => {
        const res = await request('/admin/v1/analytics/retry-after');
        return res.data.distribution;
    },
    getRedisTopology: async () => {
        const res = await request('/admin/v1/redis/topology');
        return res.data;
    },
    getOverrides: async () => {
        const res = await request('/admin/v1/overrides');
        return res.data.overrides;
    },
    createOverride: async (override) => {
        const res = await request('/admin/v1/overrides', {
            method: 'POST',
            body: JSON.stringify(override)
        });
        return res.data;
    },
    deleteOverride: async (key) => {
        const res = await request(`/admin/v1/overrides/${encodeURIComponent(key)}`, {
            method: 'DELETE'
        });
        return res.data;
    },
    getAllowlist: async () => {
        const res = await request('/admin/v1/allowlist');
        return res.data.allowlist;
    },
    addAllowlist: async (item) => {
        const res = await request('/admin/v1/allowlist', {
            method: 'POST',
            body: JSON.stringify(item)
        });
        return res.data;
    },
    deleteAllowlist: async (target) => {
        const res = await request(`/admin/v1/allowlist/${encodeURIComponent(target)}`, {
            method: 'DELETE'
        });
        return res.data;
    },
    getDenylist: async () => {
        const res = await request('/admin/v1/denylist');
        return res.data.denylist;
    },
    addDenylist: async (item) => {
        const res = await request('/admin/v1/denylist', {
            method: 'POST',
            body: JSON.stringify(item)
        });
        return res.data;
    },
    deleteDenylist: async (target) => {
        const res = await request(`/admin/v1/denylist/${encodeURIComponent(target)}`, {
            method: 'DELETE'
        });
        return res.data;
    },
    getJail: async () => {
        const res = await request('/admin/v1/jail');
        return res.data.jailed;
    },
    releaseJail: async () => {
        const res = await request('/admin/v1/jail/release', { method: 'POST' });
        return res.data;
    },
    getScenarios: async () => {
        const res = await request('/admin/v1/scenarios');
        return res.data.scenarios;
    },
    saveScenario: async (scenario) => {
        const res = await request('/admin/v1/scenarios', {
            method: 'POST',
            body: JSON.stringify(scenario)
        });
        return res.data;
    }
};
