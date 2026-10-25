local key = KEYS[1]
local cost = tonumber(ARGV[1])
local caller_now = tonumber(ARGV[2])
local peek_only = tonumber(ARGV[3])
local limit = tonumber(ARGV[4])
local window_ms = tonumber(ARGV[5])
local max_entries = tonumber(ARGV[6] or 10000)

local now_ms
if caller_now and caller_now > 0 then
    now_ms = caller_now
else
    local t = redis.call('TIME')
    now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local cutoff = now_ms - window_ms
-- Trim older than window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)

-- Count existing entries in ZSET and enforce hard cap on cardinality
local current_count = redis.call('ZCARD', key)
if current_count > max_entries then
    redis.call('ZREMRANGEBYRANK', key, 0, current_count - max_entries - 1)
    current_count = redis.call('ZCARD', key)
end

if current_count + cost <= limit then
    if peek_only == 0 then
        -- Insert members: timestamp:index
        for i = 1, cost do
            local member = tostring(now_ms) .. ":" .. tostring(current_count + i) .. ":" .. tostring(math.random(1000000))
            redis.call('ZADD', key, now_ms, member)
        end
        local new_count = current_count + cost
        if new_count > max_entries then
            redis.call('ZREMRANGEBYRANK', key, 0, new_count - max_entries - 1)
        end
        local ttl_sec = math.ceil(window_ms / 1000) * 2
        if ttl_sec < 1 then ttl_sec = 1 end
        redis.call('EXPIRE', key, ttl_sec)
        return {1, limit, math.max(0, limit - (current_count + cost)), now_ms + window_ms, 0, "ok"}
    else
        return {1, limit, math.max(0, limit - (current_count + cost)), now_ms + window_ms, 0, "ok"}
    end
else
    -- Find oldest entry in active window to compute retry_after
    local oldest = redis.call('ZRANGEBYSCORE', key, '(' .. cutoff, '+inf', 'WITHSCORES', 'LIMIT', 0, 1)
    local retry_after = window_ms
    if oldest and #oldest >= 2 then
        local oldest_ts = tonumber(oldest[2])
        retry_after = math.max(0, (oldest_ts + window_ms) - now_ms)
    end
    return {0, limit, math.max(0, limit - current_count), now_ms + retry_after, retry_after, "limit_exceeded"}
end
