local key = KEYS[1]
local cost = tonumber(ARGV[1])
local caller_now = tonumber(ARGV[2])
local peek_only = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local window_ms = tonumber(ARGV[5])

local now_ms
if caller_now and caller_now > 0 then
    now_ms = caller_now
else
    local t = redis.call('TIME')
    now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local window_start = math.floor(now_ms / window_ms) * window_ms
local reset_ms = window_start + window_ms
local window_key = key .. ":" .. window_start

local current_count = tonumber(redis.call('GET', window_key) or 0)

if current_count + cost <= limit then
    if peek_only == 0 then
        local next_count = redis.call('INCRBY', window_key, cost)
        local ttl_sec = math.ceil((reset_ms - now_ms) / 1000) + 1
        if ttl_sec < 1 then ttl_sec = 1 end
        redis.call('EXPIRE', window_key, ttl_sec)
        return {1, limit, math.max(0, limit - next_count), reset_ms, 0, "ok"}
    else
        return {1, limit, math.max(0, limit - (current_count + cost)), reset_ms, 0, "ok"}
    end
else
    local retry_after = math.max(0, reset_ms - now_ms)
    return {0, limit, math.max(0, limit - current_count), reset_ms, retry_after, "limit_exceeded"}
end
