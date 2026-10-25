local key = KEYS[1]
local cost = tonumber(ARGV[1])
local caller_now = tonumber(ARGV[2])
local peek_only = tonumber(ARGV[3])
local capacity = tonumber(ARGV[4])
local refill_rate = tonumber(ARGV[5])

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

local data = redis.call('HMGET', key, 'tokens', 'last_refill')
local tokens = tonumber(data[1])
local last_refill = tonumber(data[2])

if not tokens then
    tokens = capacity
    last_refill = now_ms
else
    local elapsed_ms = math.max(0, now_ms - last_refill)
    local refilled = elapsed_ms * (refill_rate / 1000)
    tokens = math.min(capacity, tokens + refilled)
    last_refill = now_ms
end

local allowed = 0
local remaining = 0
local retry_after = 0
local reason = "ok"

if tokens >= cost then
    allowed = 1
    if peek_only == 0 then
        tokens = tokens - cost
    end
    remaining = math.max(0, math.floor(tokens))
    retry_after = 0
else
    allowed = 0
    remaining = math.max(0, math.floor(tokens))
    local deficit = cost - tokens
    retry_after = refill_rate > 0 and math.ceil((deficit / refill_rate) * 1000) or -1
    reason = "limit_exceeded"
end

if peek_only == 0 then
    local ttl_sec = refill_rate > 0 and math.ceil((capacity / refill_rate) * 2) or 3600
    if ttl_sec < 1 then ttl_sec = 1 end
    redis.call('HMSET', key, 'tokens', tokens, 'last_refill', last_refill)
    redis.call('EXPIRE', key, ttl_sec)
end

local reset_ms = now_ms + (retry_after > 0 and retry_after or 0)
return {allowed, math.floor(capacity), remaining, reset_ms, retry_after, reason}
