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
local prev_window_start = window_start - window_ms
local reset_ms = window_start + window_ms

local curr_key = key .. ":" .. window_start
local prev_key = key .. ":" .. prev_window_start

local curr_count = tonumber(redis.call('GET', curr_key) or 0)
local prev_count = tonumber(redis.call('GET', prev_key) or 0)

local elapsed = math.max(0, now_ms - window_start)
local weight = math.min(1, math.max(0, elapsed / window_ms))
local estimated = prev_count * (1 - weight) + curr_count

if estimated + cost <= limit then
    if peek_only == 0 then
        local next_curr = redis.call('INCRBY', curr_key, cost)
        local ttl_sec = math.ceil((window_ms * 2) / 1000) + 1
        redis.call('EXPIRE', curr_key, ttl_sec)
        local remaining = math.max(0, math.floor(limit - (prev_count * (1 - weight) + next_curr)))
        return {1, limit, remaining, reset_ms, 0, "ok"}
    else
        local remaining = math.max(0, math.floor(limit - (estimated + cost)))
        return {1, limit, remaining, reset_ms, 0, "ok"}
    end
else
    local remaining = math.max(0, math.floor(limit - estimated))
    local retry_after = math.max(0, reset_ms - now_ms)
    return {0, limit, remaining, reset_ms, retry_after, "limit_exceeded"}
end
