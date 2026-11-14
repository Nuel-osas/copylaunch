# CopyLaunch. Testnet only.
.PHONY: test build deploy demo web web-build check-deployed

## Contract unit tests (token + launchpad). No network, no keys.
test:
	cargo test

## Build both contracts to build/ (token first: the launchpad embeds it).
build:
	./scripts/build.sh

## Deploy build/copylaunch.wasm to copylaunch.testnet (needs that account's key in ~/.near-credentials).
deploy: build
	cd scripts && npm ci --no-audit --no-fund && node deploy.mjs

## Real testnet transactions through every feature, with checks. Needs three funded testnet accounts.
demo:
	cd scripts && npm ci --no-audit --no-fund && node demo.mjs

## Compare the code deployed on testnet with build/ (run `make build` first).
check-deployed:
	cd scripts && npm ci --no-audit --no-fund && node check-deployed.mjs

## The web app at http://localhost:5173
web:
	cd web && npm ci --no-audit --no-fund && npx vite

web-build:
	cd web && npm ci --no-audit --no-fund && npx vite build
