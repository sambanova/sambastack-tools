# SambaEval — dev + deploy targets (samba-chat pattern; see private/prodplan.md §6/§8a).
# Local dev uses docker-compose (Mode A); prod deploys the umbrella Helm chart to
# the on-prem RKE2 vcluster tenant. Prod targets are best-effort scaffolds.

SHELL := /bin/bash

# ---- config -----------------------------------------------------------------
COMPOSE_INFRA := docker compose -f deploy/local/docker-compose.infra.yml
COMPOSE_STACK := docker compose -f deploy/local/docker-compose.yml
ENV_FILE      := deploy/local/.env
ENV_EXAMPLE   := deploy/local/.env.example

# Seed bundle (prodplan §5). Local host env for the one-time upload to MinIO.
SEED_PREFIX   ?= seed
LOCAL_S3_ENV  := S3_ENDPOINT_URL=http://localhost:9100 S3_BUCKET=sambaeval S3_ACCESS_KEY=sambaeval S3_SECRET_KEY=sambaeval-secret SAMBAEVAL_ENV=local

# Image tag defaults to the short git SHA (samba-chat convention).
TAG ?= $(shell git rev-parse --short HEAD)

# Artifact Registry (GCP). Adjust REPO to the provisioned AR repository.
REGISTRY      ?= us-west2-docker.pkg.dev/acp-starterkits-development-57
REPO          ?= sambaeval
BACKEND_IMAGE ?= $(REGISTRY)/$(REPO)/backend
FRONTEND_IMAGE?= $(REGISTRY)/$(REPO)/frontend
PLATFORM      ?= linux/amd64

# Helm / cluster
RELEASE   ?= sambaeval
CHART     ?= helm/sambaeval
NAMESPACE ?= default
# Deploy overlay: renders values-$(ENV).yaml on top of values.yaml.
ENV       ?= prod
SECRET_NAME ?= sambaeval-credentials-env
REGCRED   ?= regcred

.PHONY: help
help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | \
	  awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

# =============================================================================
# Local dev (Mode A)
# =============================================================================
$(ENV_FILE):
	@test -f $(ENV_FILE) || (cp $(ENV_EXAMPLE) $(ENV_FILE) && echo "created $(ENV_FILE) from example")

.PHONY: dev-infra
dev-infra: ## Bring up infra only (postgres + minio) for native api/worker/frontend
	$(COMPOSE_INFRA) up -d

.PHONY: dev-stack
dev-stack: $(ENV_FILE) ## Build + run the FULL local stack (pg+minio+api+worker+frontend)
	$(COMPOSE_STACK) up -d --build
	@echo "SambaEval up -> http://localhost:3001 (api http://localhost:8000)"

.PHONY: seed-upload
seed-upload: ## Upload the example data/ tree to the object store bundle (once; the prod seed source)
	cd backend && $(LOCAL_S3_ENV) .venv/bin/python -m sambaeval.seed_bundle push --data-dir ../data --prefix $(SEED_PREFIX)

.PHONY: dev-seed
dev-seed: seed-upload ## Seed local Postgres + MinIO from the object-store bundle (§5 — same path as the prod seed Job)
	$(COMPOSE_STACK) exec -T api sambaeval-backfill --seed-prefix $(SEED_PREFIX)
	# The prod seed Job runs the identical command (helm --set seed.enabled=true);
	# the only difference is where `sambaeval-seed push` uploaded the bundle.

.PHONY: dev-logs
dev-logs: ## Tail the full-stack logs
	$(COMPOSE_STACK) logs -f

.PHONY: dev-stop
dev-stop: ## Stop the full local stack (keep volumes/data)
	$(COMPOSE_STACK) down

.PHONY: dev-nuke
dev-nuke: ## Stop the full local stack AND delete volumes (postgres + minio data)
	$(COMPOSE_STACK) down -v

.PHONY: migrate
migrate: ## Run Alembic migrations against DATABASE_URL (host-native)
	cd backend && alembic upgrade head

# =============================================================================
# Images (prod scaffold) — docker buildx -> Artifact Registry
# =============================================================================
.PHONY: build-all
build-all: ## Build backend + frontend images for $(PLATFORM), tag $(TAG)
	docker buildx build --platform $(PLATFORM) -f backend/Dockerfile \
	  -t $(BACKEND_IMAGE):$(TAG) -t $(BACKEND_IMAGE):latest --load .
	docker buildx build --platform $(PLATFORM) -f Dockerfile \
	  -t $(FRONTEND_IMAGE):$(TAG) -t $(FRONTEND_IMAGE):latest --load .

.PHONY: push-all
push-all: ## Build + push backend + frontend images to Artifact Registry
	docker buildx build --platform $(PLATFORM) -f backend/Dockerfile \
	  -t $(BACKEND_IMAGE):$(TAG) --push .
	docker buildx build --platform $(PLATFORM) -f Dockerfile \
	  -t $(FRONTEND_IMAGE):$(TAG) --push .

# =============================================================================
# Secrets / regcred (prod scaffold) — imperative K8s Secret, samba-chat pattern
# =============================================================================
.PHONY: create-secrets
create-secrets: $(ENV_FILE) ## Create the single sambaeval-credentials-env Secret (crypto via openssl rand)
	# SESSION_SECRET + CREDS_KEY are minted fresh; app credentials come from $(ENV_FILE).
	# CREDS_KEY must be a urlsafe-base64 32-byte Fernet key.
	set -euo pipefail; \
	source $(ENV_FILE); \
	SESSION_SECRET=$${SESSION_SECRET:-$$(openssl rand -hex 32)}; \
	CREDS_KEY=$${CREDS_KEY:-$$(openssl rand -base64 32 | tr '+/' '-_')}; \
	kubectl -n $(NAMESPACE) create secret generic $(SECRET_NAME) \
	  --from-literal=SESSION_SECRET="$$SESSION_SECRET" \
	  --from-literal=CREDS_KEY="$$CREDS_KEY" \
	  --from-literal=DATABASE_URL="$$DATABASE_URL" \
	  --from-literal=POSTGRES_PASSWORD="$$POSTGRES_PASSWORD" \
	  --from-literal=S3_ACCESS_KEY="$$S3_ACCESS_KEY" \
	  --from-literal=S3_SECRET_KEY="$$S3_SECRET_KEY" \
	  --from-literal=MINIO_ROOT_USER="$$S3_ACCESS_KEY" \
	  --from-literal=MINIO_ROOT_PASSWORD="$$S3_SECRET_KEY" \
	  --from-literal=GOOGLE_CLIENT_ID="$${GOOGLE_CLIENT_ID:-}" \
	  --from-literal=GOOGLE_CLIENT_SECRET="$${GOOGLE_CLIENT_SECRET:-}" \
	  --dry-run=client -o yaml | kubectl apply -f -

.PHONY: create-regcred
create-regcred: ## Mint the Artifact Registry pull secret from a short-lived token
	kubectl -n $(NAMESPACE) create secret docker-registry $(REGCRED) \
	  --docker-server=$(REGISTRY) \
	  --docker-username=oauth2accesstoken \
	  --docker-password="$$(gcloud auth print-access-token)" \
	  --dry-run=client -o yaml | kubectl apply -f -

# =============================================================================
# Deploy (prod scaffold) — helm dependency build -> preflight -> upgrade
# =============================================================================
.PHONY: helm-deps
helm-deps: ## Resolve subchart dependencies (postgres + minio)
	helm dependency build $(CHART)

.PHONY: preflight
preflight: ## Confirm the image tag exists in Artifact Registry (avoid ImagePullBackOff)
	gcloud artifacts docker images describe $(BACKEND_IMAGE):$(TAG) >/dev/null
	gcloud artifacts docker images describe $(FRONTEND_IMAGE):$(TAG) >/dev/null

.PHONY: deploy
deploy: helm-deps preflight ## helm upgrade --install with layered values ($(ENV))
	helm upgrade --install $(RELEASE) $(CHART) \
	  --namespace $(NAMESPACE) \
	  --values $(CHART)/values.yaml \
	  --values $(CHART)/values-$(ENV).yaml \
	  --set image.backend.repository=$(BACKEND_IMAGE) \
	  --set image.frontend.repository=$(FRONTEND_IMAGE) \
	  --set image.tag=$(TAG)

.PHONY: template
template: helm-deps ## Render the chart locally (Mode B parity check)
	helm template $(RELEASE) $(CHART) \
	  --values $(CHART)/values.yaml \
	  --values $(CHART)/values-local.yaml

.PHONY: lint
lint: ## helm lint the chart
	helm lint $(CHART) --values $(CHART)/values.yaml --values $(CHART)/values-prod.yaml
