.PHONY: help build test smoke e2e bench typecheck clean gateway web audit-verify ml-bench perf all

help:
	@echo "RLGW - Distributed Rate-Limiting Gateway (MERN TypeScript)"
	@echo ""
	@echo "Available targets:"
	@echo "  help          Show this help message"
	@echo "  build         Build TypeScript packages and gateway application"
	@echo "  test          Run all vitest unit and property test suites"
	@echo "  smoke         Run smoke tests against live mock upstreams"
	@echo "  e2e           Run full end-to-end integration test suites"
	@echo "  typecheck     Run TypeScript strict type checking across monorepo"
	@echo "  bench         Run micro and macro rate limiter benchmarks"
	@echo "  perf          Run performance suite (use SCALE=smoke|full)"
	@echo "  web           Build React 18 admin console bundle"
	@echo "  audit-verify  Verify SHA-256 tamper-evident security audit log chains"
	@echo "  ml-bench      Run AI/ML Isolation Forest vs Heuristic benchmark"
	@echo "  gateway       Start the gateway using examples/gateway.yaml"
	@echo "  clean         Clean build artifacts and temporary files"

build:
	npm run build

test:
	npm test

smoke:
	npm run smoke

e2e:
	npm run test:p1

typecheck:
	npm run typecheck

bench:
	npm run bench

perf:
	npx tsx scripts/perf.mjs

web:
	npm run build:web

local-up:
	npm run local:up

local-down:
	npm run local:down

local-verify:
	npm run local:verify

demo-reset:
	npm run seed:dev

audit-verify:
	npx tsx scripts/audit-verify.mjs

ml-bench:
	npx tsx scripts/ml-bench.mjs

gateway:
	node apps/gateway/dist/main.js -config examples/gateway.yaml

all: typecheck test web audit-verify ml-bench

clean:
	rm -rf dist apps/gateway/dist logs/p*/*.log apps/web/dist .local

