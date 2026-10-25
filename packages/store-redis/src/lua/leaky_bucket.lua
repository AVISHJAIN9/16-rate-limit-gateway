local key = KEYS[1]
local cost = tonumber(ARGV[1])
local caller_now = tonumber(ARGV[2])
local peek_only = tonumber(ARGV[3])
local capacity = tonumber(ARGV[4])
local leak_rate = tonumber(ARGV[5])
local variant = ARGV[6] or "policing"

local now_ms
if caller_now and caller_now > 0 then
    now_ms = caller_now
else
    local t = redis.call('TIME')
    now_ms = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end

if cost > capacity then
    return {0, math.floor(capacity), 0, now_ms, -1, "cost_exceeds_burst"}
end

local data = redis.call('HMGET', key, 'level', 'last_leak')
local level = tonumber(data[1])
local last_leak = tonumber(data[2])

if not level then
    level = 0
    last_leak = now_ms
else
    local elapsed_ms = math.max(0, now_ms - last_leak)
    local leaked = elapsed_ms * (leak_rate / 1000)
    level = math.max(0, level - leaked)
    last_leak = now_ms
end

local allowed = 0
local remaining = 0
local retry_after = 0
local reason = "ok"

if level + cost <= capacity then
    allowed = 1
    if peek_only == 0 then
        level = level + cost
    end
    remaining = math.max(0, math.floor(capacity - level))
    retry_after = 0
else
    allowed = 0
    remaining = math.max(0, math.floor(capacity - level))
    local excess = (level + cost) - capacity
    retry_after = leak_rate > 0 and math.ceil((excess / leak_rate) * 1000) or -1
    reason = variant == "shaping" and "delayed" or "limit_exceeded"
end

if peek_only == 0 then
    local ttl_sec = leak_rate > 0 and math.ceil((capacity / leak_rate) * 2) or 3600
    if ttl_sec < 1 then ttl_sec = 1 end
    redis.call('HMSET', key, 'level', level, 'last_leak', last_leak)
    redis.call('EXPIRE', key, ttl_sec)
end

local reset_ms = now_ms + (retry_after > 0 and retry_after or 0)
return {allowed, math.floor(capacity), remaining, reset_ms, retry_after, reason}
