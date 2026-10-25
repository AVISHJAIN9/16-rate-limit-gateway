local key = KEYS[1]
local cost = tonumber(ARGV[1])
local caller_now = tonumber(ARGV[2])
local peek_only = tonumber(ARGV[3])
local capacity = tonumber(ARGV[4])
local rate_per_second = tonumber(ARGV[5])

local now_ms
if caller_now and caller_now > 0 then
    now_ms = caller_now
else
    local t = redis.call('TIME')
    now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

local interval_ms = 1000 / rate_per_second
local burst_tolerance_ms = (capacity - 1) * interval_ms

local tat_ms = tonumber(redis.call('GET', key) or 0)
if tat_ms <= 0 then
    tat_ms = now_ms
end

local earliest_eligible_ms = tat_ms - burst_tolerance_ms

if now_ms >= earliest_eligible_ms then
    local next_tat_ms = math.max(now_ms, tat_ms) + (peek_only == 1 and 0 or (interval_ms * cost))
    local remaining_ms = math.max(0, next_tat_ms - now_ms)
    local remaining = math.max(0, math.floor((burst_tolerance_ms - remaining_ms) / interval_ms))

    if peek_only == 0 then
        local ttl_sec = math.ceil((burst_tolerance_ms + (interval_ms * cost) * 2) / 1000) + 1
        if ttl_sec < 1 then ttl_sec = 1 end
        redis.call('SET', key, next_tat_ms, 'EX', ttl_sec)
    end

    return {1, capacity, remaining, math.floor(next_tat_ms), 0, "ok"}
else
    local retry_after = math.max(0, math.ceil(earliest_eligible_ms - now_ms))
    return {0, capacity, 0, now_ms + retry_after, retry_after, "limit_exceeded"}
end
