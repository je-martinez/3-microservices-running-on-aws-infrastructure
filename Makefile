# Local development orchestration for 3MRAI.
# Run `make help` (the default) to list targets.
# Two layers: docker-compose (Floci + services) and Terraform against Floci.

COMPOSE      := docker compose
TF_LOCAL_DIR := infra/environments/local
TF           := terraform -chdir=$(TF_LOCAL_DIR)
FLOCI_URL    := http://localhost:4566
ENV_FILE     := .env

# Terraform talks to Floci through the host-published port; the AWS provider in
# environments/local/providers.tf pins every endpoint to localhost:4566.
export AWS_ENDPOINT_URL    ?= $(FLOCI_URL)
export AWS_DEFAULT_REGION  ?= us-east-1
export AWS_ACCESS_KEY_ID   ?= test
export AWS_SECRET_ACCESS_KEY ?= test

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps infra-init infra-plan infra-up infra-down infra-output env-file bootstrap clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| sort \
		| awk 'BEGIN {FS = ":.*?## "} {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

## --- Docker Compose ---

up: ## Start the stack (Floci + services) in the background
	$(COMPOSE) up -d

down: ## Stop the stack
	$(COMPOSE) down

logs: ## Tail logs (optional: make logs S=users)
	$(COMPOSE) logs -f $(S)

build: ## Build service images
	$(COMPOSE) build

ps: ## Show container status
	$(COMPOSE) ps

## --- Terraform (against Floci) ---

infra-init: ## terraform init (environments/local)
	$(TF) init

infra-plan: ## terraform plan (environments/local)
	$(TF) plan

infra-up: ## terraform apply -auto-approve (environments/local), then refresh .env
	$(TF) apply -auto-approve
	$(MAKE) env-file

infra-down: ## terraform destroy -auto-approve (environments/local)
	$(TF) destroy -auto-approve

infra-output: ## Show terraform outputs (Cognito IDs, etc.)
	$(TF) output

env-file: ## Regenerate ./.env from terraform outputs (Cognito IDs)
	@# Floci mints a new user-pool/client ID on every apply, so .env must be
	@# rewritten from the live outputs — never hand-edited. docker-compose reads
	@# COGNITO_USER_POOL_ID / COGNITO_CLIENT_ID from here for the users service.
	@printf 'COGNITO_USER_POOL_ID=%s\nCOGNITO_CLIENT_ID=%s\n' \
		"$$($(TF) output -raw cognito_user_pool_id)" \
		"$$($(TF) output -raw cognito_client_id)" > $(ENV_FILE)
	@echo "wrote $(ENV_FILE) from terraform outputs"

## --- Orchestration ---

bootstrap: ## Bring the whole local chain up from scratch, in dependency order
	@# Order matters. The services cannot start before the infra exists: `users`
	@# validates COGNITO_* with Zod at boot, and those IDs only exist after apply.
	@# So: Floci first, then terraform, then .env, then bootstrap.sh (app DB user
	@# + nginx alias), and only then the services.
	$(COMPOSE) up -d floci
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) infra-init
	$(MAKE) infra-up
	$(COMPOSE) up -d --build users
	bash $(TF_LOCAL_DIR)/bootstrap.sh

clean: ## Tear down infra + compose (prompts before removing ./data)
	-$(TF) destroy -auto-approve
	$(COMPOSE) down
	@printf "Remove ./data (local emulator state)? [y/N] "; read ans; \
		if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then rm -rf ./data && echo "removed ./data"; else echo "kept ./data"; fi
