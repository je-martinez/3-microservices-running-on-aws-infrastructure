# 3 Microservices Running on AWS Infrastructure (3MRAI Company)

Linear Workspace: je-martinez
Linear Project - 3MRAI Company

We are going to create a complete project with 3 microservices running on AWS infrastructure, running locally using Ministack (https://ministack.org/docs/). The 3 microservices will be Users, Orders, and Trackings.

## Specs for Infrastructure

- All AWS resources will be created using Terraform modules, building our own modules with the resources we need. Names will be based on the cloudposse/label/null module https://registry.terraform.io/modules/cloudposse/label/null/latest
- SQS Messages triggering a Lambda that will receive them.
- API Gateway that redirects to a Load Balancer pointing to the services. Authentication and Authorization using AWS Cognito.
- For local development, the API Gateway -> Load Balancer -> Docker Container that has docker watch (described in other sections).
- The databases will have one read-only replica and another for writing. A user will be created for each database, where this user will be forbidden from running DELETEs, since only soft delete is supported. As soon as the user is created, it will be stored as a secret in AWS Secret Manager.
- The microservices run on ECS as Fargate tasks, pulling their image from ECR. This is only for production. For local development, redirect to the instances running in Docker with docker-watch. Make sure everything runs under the same network and that they have connectivity. Use Route 53 for the names.
- All environment variables and secrets for the microservices will be pulled using AWS Parameter Store and AWS Secret Manager; the .env files will only serve to sync the parameters or secrets locally.

## Shared Specs for Microservices
- Use dependency injection.
- Use the CQRS pattern.
- Use screaming architecture.
- Each microservice will have its own database.
- All logs should be captured via AWS CloudWatch and sent to a SigNoz instance https://signoz.io/docs/introduction/
- For local development, we do not expect the project to run in a Docker image using docker-compose with docker-watch for changes.
- All environment variables and secrets for the microservices will be pulled using AWS Parameter Store and AWS Secret Manager; the .env files will only serve to sync the parameters or secrets locally. Use a validation schema such as Zod for all the variables needed to run the service.
- Each microservice has two environments, local and production, where local spins up the project with Docker Watch, while production uses AWS ECR.
- Consider that we use a read replica and a write replica for the database.
- Use gRPC for communication between microservices.
- Use versioning in all microservices.
- The microservices only support soft delete; there are no explicit deletes. Override delete functions where possible.
- The database fields and attributes will be mapped using aliases in Pascal case, since in the database they have been mapped as Snake case.

## Specs for the Database
- Entity IDs are generated similar to how Stripe does it, using nano id. For example, Orders would be ord_wldA4A0WwZAKUm
- Use ORMs: Prisma, EntityFramework, and SQL Alchemy.
- 1 Read Replica and 1 Write Replica.
- Database fields are normalized as snake_case.
- Include indexes to improve performance.

### Audit Fields
- createdBy
- createdAt
- updatedBy
- updatedAt
- deletedBy
- deletedAt
- Computed property, isDeleted, based on whether the deletedAt field is set.

## Specs for the Users Microservice

- Stack: Fastify
- Database Engine: Aurora Postgres

This service will be responsible for creating and authenticating users via AWS Cognito. The endpoints are the following:

- [POST] /users/register - Generates an SQS message with type USER_CREATED
- [POST] /users/login
- [GET/PATCH] /users/me

### gRPC Methods
- Get User by Id

### Database Description

#### Users
- id
- email
- fullName
- address (JSONB)
- phone_number
- audit fields

## Specs for the Orders Microservice

- Stack: .NET Core 10 - Minimal APIs
- Database Engine: Aurora MySQL

This service is responsible for creating the orders that are submitted by users. The endpoints are the following:

- [POST] /orders - Generates an SQS message of type ORDER_CREATED
- [GET] /orders/my-orders
- [GET] /orders/<order_id> - Verify that the order being fetched belongs to that user.

### gRPC Methods
- Get Order by Id

### Database Description

#### Product
- id
- name
- description
- unit_price
- units_in_stock
- audit fields

#### Order
- id
- user_id
- subtotal
- tax
- total
- audit fields

#### Order Details
- id
- product_id
- user_id
- quantity
- subtotal
- tax
- total
- audit fields

## Specs for the Tracking Microservice

Stack: FastAPI
Database Engine: Aurora MySQL

This service is responsible for creating the tracking for orders. The endpoints are the following:

- [POST] /trackings.
- [PUT] /trackings/<order_id>/status.

### gRPC Methods
- Get Tracking by OrderId
- Get Trackings by List of OrderId

### Database Description

Tracking
- id
- user_id
- order_id
- status
- datetime
- audit fields

Tracking_History
- tracking_id pk
- user_id pk
- order_id pk
- status pk
- datetime
- audit fields

## Specs for SQS -> Lambda

- Engine: DocumentDB + Schema

Use CQRS, where each type received will be dispatched to its own handler as if it were a map. For example ORDER_CREATED => OrderCreatedHandler. All within a single Lambda.

The SQS Message arrives. It is saved in the database with status STARTED.
The SQS Message is passed to be processed. Its status changes to IN PROGRESS and it goes to the handler.
If an error occurs, the error is saved and the status is set to FAILED.
If processing finishes without errors, the status is set to COMPLETED.

### Database Description

#### Events
- friendlyId: The same prefix_nanoId rules as the relational databases apply.
- order_id
- user_id
- type
- source, which microservice it comes from.
- payload (object)
- status_history (array of objects)
- audit fields


## Obsidian

A couple of Obsidian rules

### Folder map

| Folder | Purpose |
|---|---|
| [`specs/`](specs/) | Design specs — the "what & why" output of brainstorming/planning sessions. Pairs with a plan: **spec = design, plan = execution**. Use `spec-template.md`. |
| [`plans/`](plans/) | Active plans for in-flight work. Use `plan-template.md`. |
| [`plans/archive/`](plans/archive/) | Completed/abandoned plans, named `YYYY-MM-DD-short-title.md`. |
| [`lessons/`](lessons/) | Durable lessons from past iterations (one lesson per file). |
| [`decisions/`](decisions/) | Architecture Decision Records (ADRs), numbered `ADR-NNNN`. |
| [`retros/`](retros/) | Iteration / sprint retrospectives. |
| [`ideas/`](ideas/) | Loose notes on things worth exploring later. |
| [`testing/`](testing/) | Manual smoke-test playbooks per phase. |
| [`onboarding/`](onboarding/) | End-user / new-dev setup guides — start with [`new-contributor-quickstart.md`](onboarding/new-contributor-quickstart.md). Evergreen, no date prefix. |
| [`runbooks/`](runbooks/) | Owner-run manual procedures — OAuth flows, external dashboards, permission grants. Evergreen (no date prefix). Use `runbook-template.md`. Integration runbooks carry `integration` tag + `integration-status` / `verified-on` / `verified-by` fields (see below). |
| [`templates/`](templates/) | Frontmatter + skeleton for each note type. |

### Conventions

- **Wiki links:** `[[note-name]]` for cross-references inside the vault.
- **Tags:** `#lesson`, `#decision`, `#area/<subsystem>`, `#severity/<low|medium|high>`, `#phase/<n>`. Use folder-style tags for facets.
- **Filenames:** `YYYY-MM-DD-short-title.md` for dated notes (lessons, retros, archived plans). ADRs use `ADR-NNNN-title.md`.
- **Frontmatter:** every note has YAML frontmatter (start from a [template](templates/)). See the per-type field set below.
