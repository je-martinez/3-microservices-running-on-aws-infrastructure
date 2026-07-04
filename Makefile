# Local development orchestration for 3MRAI.
# Run `make help` (the default) to list targets.
# Two layers: docker-compose (Floci + services) and Terraform against Floci.

COMPOSE      := docker compose
TF_LOCAL_DIR := infra/environments/local/spike-floci
TF           := terraform -chdir=$(TF_LOCAL_DIR)
FLOCI_URL    := http://localhost:4566

.DEFAULT_GOAL := help

.PHONY: help up down logs build ps infra-init infra-plan infra-up infra-down infra-output bootstrap clean

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

infra-init: ## terraform init (spike-floci)
	$(TF) init

infra-plan: ## terraform plan (spike-floci)
	$(TF) plan

infra-up: ## terraform apply -auto-approve (spike-floci)
	$(TF) apply -auto-approve

infra-down: ## terraform destroy -auto-approve (spike-floci)
	$(TF) destroy -auto-approve

infra-output: ## Show terraform outputs (Cognito IDs, etc.)
	$(TF) output

## --- Orchestration ---

bootstrap: up ## Bring everything up: compose, wait for Floci, then apply infra
	@echo "Waiting for Floci at $(FLOCI_URL) ..."
	@for i in $$(seq 1 30); do \
		if curl -sf -o /dev/null "$(FLOCI_URL)"; then echo "Floci is up."; break; fi; \
		if [ $$i -eq 30 ]; then echo "Floci did not become ready in time." >&2; exit 1; fi; \
		sleep 1; \
	done
	$(MAKE) infra-init
	$(MAKE) infra-up

clean: ## Tear down infra + compose (prompts before removing ./data)
	-$(TF) destroy -auto-approve
	$(COMPOSE) down
	@printf "Remove ./data (local emulator state)? [y/N] "; read ans; \
		if [ "$$ans" = "y" ] || [ "$$ans" = "Y" ]; then rm -rf ./data && echo "removed ./data"; else echo "kept ./data"; fi
