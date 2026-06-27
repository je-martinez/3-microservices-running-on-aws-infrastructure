# 3 Microservices Running on AWS Infrastructure (3MRAI Company)

Linear Workspace: je-martinez
Linear Project - 3MRAI Company

Vamos a crear un proyecto completo con 3 microservicios corriendo en infraestructura de AWS corriendo de forma local usando Ministack (https://ministack.org/docs/) . Los 3 microservices serán Users, Orders y Trackings.

## Specs para Infraestructura

- Todos los recursos de AWS serán creados usando terraform modules, creando módulos propios con los recursos que necesitamos. Los nombres seran basado usando el cloudposse/label/null module https://registry.terraform.io/modules/cloudposse/label/null/latest
- Los SQS Messages levantando una lambda que recibirá
- API Gateway que redirige a Load Balancer que apuntan a los servicios. Authentication y Authorization usando AWS Cognito.
- Para desarrollo local las API Gateway -> Load Balancer -> Docker Container que tiene docker watch (descrito en otras secciones).
- Las bases de datos van a tener una replica de solo lectura y otra para escritura. Donde se creara un usuario para cada base de datos, donde este tendrá prohibido los DELETED, puesto que solo soft delete es soportado. Tan pronto como el usuario sea creado se va guardar como secreto en AWS Secret Manager.
- Los microservicios corren en ECS como tasks de Fargate, trayendo su image de ECR. Esto solo para producción.Para desarrollo local redirigir a las instancias que corren en docker con docker-watch. Asegúrate que todo corra bajo la misma network y que tengan conectividad. Usar Route 53 para los nombres.
- Todas las variables de entorno y secretos para los microservicios serán traídos usando AWS Parameter Store y AWS Secret Manager, los .env solo servirán para sincronizar localmente los parameters o secretos.
- Incluir diagramas con draw.io para flujos, infrastructura, etc.

## Specs Compartidos para Microservicios
- Usar dependency injection.
- Usar CQRS pattern.
- Usar screaming architecture.
- Cada microservicio tendrá su propia base de datos.
- Todos los logs deberían ser capturados mediante AWS CloudWatch y ser enviados a una instancia de SigNoz https://signoz.io/docs/introduction/
- Para el desarrollo local no esperamos se va correr el proyecto en una imagen de docker usando docker-compose con docker-watch para los cambios.
- Todas las variables de entorno y secretos para los microservicios serán traídos usando AWS Parameter Store y AWS Secret Manager, los .env solo servirán para sincronizar localmente los parameters o secretos. Usar schema de validación como por ejemplo Zod para todas las variables necesarias para correr al servicio.
- Cada microservicios tiene dos ambientes, local y production, dónde local levanta el proyecto con Docker Watch, mientras producion con AWS ECR.
- Considerar que usamos una réplica de lectura y escritura para la base de datos.
- Usar gRPC para comunicación entre microservicios.
- Usar versioning en todos los microservicios.
- Los microservicios solo soportan soft deleted, no hay delete explicitos. Sobre escribir funciones delete de ser posible.
- Los campos y atributos de la base de datos serán mapeados mediante alias en Pascal case puesto que en la base de datos se han mapeado como Snake case.

## Specs para base de datos
- Los IDs de las entidades se generan similar a como lo hace Stripe haciendo uso de nano id. Por ejemplo. Orders, seria ord_wldA4A0WwZAKUm
- Usar ORMs. Prisma, EntityFramework y SQL Alchemy.
- 1 Read Replica y 1 Write Replica.
- Los campos de la base de datos están normalizados como snake_case.
- Incluir indexes para mejorar el performance.

### Campos de Auditoría
- createdBy
- createdAt
- updatedBy
- updatedAt
- deletedBy
- deletedAt
- Propiedad computada, isDeleted, basada en si el campo deletedAt.

## Specs para Users Microservice

- Stack: Fastify
- Database Engine: Aurora Postgres

Este servicio será encargado de crear y autenticar los usuarios mediante AWS Cognito. Los endpoints sean los siguientes:

- [POST] /users/register - Genera un SQS message con type USER_CREATED
- [POST] /users/login
- [GET/PATCH] /users/me

### Métodos gRPCs 
- Get User by Id

### Descripción para la base de datos

#### Users
- id
- email
- fullName
- address (JSONB)
- phone_number
- campos de auditoría

## Specs para Orders Microservice

- Stack: .NET Core 10 - Minimal APIs
- Database Engine: Aurora MySQL

Este servicio es el encargado de crear las órdenes que son enviadas por los usuarios. Los endpoints son los siguientes:

- [POST] /orders - Genera un SQS message de type ORDER_CREATED
- [GET] /orders/my-orders
- [GET] /orders/<order_id> - Verificar si la orden que se está trayendo pertenece a ese usuario.

### Métodos gRPCs 
- Get Order by Id

### Descripción para la base de datos

#### Product
- id
- name
- description
- unit_price
- units_in_stock
- campos de auditoría

#### Order
- id
- user_id
- subtotal
- tax
- total
- campos de auditoría

#### Order Details
- id
- product_id
- user_id
- quantity
- subtotal
- tax
- total
- campos de auditoría

## Specs para Tracking Microservice

Stack: FastAPI
Database Engine: Aurora MySQL

Este servicio es el encargado de crear el tracking para las órdenes. Los endpoints serán los siguientes:

- [POST] /trackings.
- [PUT] /trackings/<order_id>/status.

### Métodos gRPCs 
- Get Tracking by OrderId
- Get Trackings by List of OrderId

### Descripción para la base de datos

Tracking
- id
- user_id
- order_id
- status
- datetime
- campos de auditoría

Tracking_History
- tracking_id pk
- user_id pk
- order_id pk
- status pk
- datetime
- campos de auditoría

## Specs Para SQS -> Lambda

- Engine: DocumentDB + Schema

Usar CQRS, donde cada type que reciba será enviado a su propio handler como si se tratara de un map. Por ejemplo ORDER_CREATED => OrderCreatedHandler. Todo dentro de una lambda.

Llega el SQS Message. Se guarda en la base de datos con status STARTED.
Pasa el SQS Message a ser procesado. Su estado cambia a IN PROGRESS y pasa al handler.
De suceder un error, se guarda el error y se coloca en status FAILED.
De terminar el procesamiento sin error, se coloca status COMPLETED.

### Descripción para la base de datos

#### Events
- friendlyId: Aplican las mismas reglas de prefix_nanoId de las base de datos relacionales.
- order_id
- user_id
- type
- source, de que microservice viene.
- payload (object)
- status_history (array of objects)
- campos de auditoría


## Obsidian

Un par de reglas de obsidian

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