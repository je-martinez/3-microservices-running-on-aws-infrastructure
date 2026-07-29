---
title: "Developer Experience Milestone — Original Input (Spanish)"
type: reference
area: shared
status: active
created: 2026-07-19
updated: 2026-07-19
tags:
  - type/reference
  - area/shared
  - status/active
---

# Developer Experience Milestone — Original Input (Spanish)

This is the user's original three-block input (in Spanish, kept verbatim below) that the **Developer Experience** milestone grew from. It arrived as a single note (`new-milestone.md` at the repo root) describing three independent pieces of work:

1. **Bash-to-Python script migration** — specced in [[2026-07-19-scripts-to-python-migration-design]] (plan: [[2026-07-19-scripts-to-python-migration]]).
2. **Logging context + distributed tracing** — not yet specced.
3. **Env-file auto-generation** — not yet specced.

See [[developer-experience-milestone]] for how these three blocks are tracked as one Linear milestone.

> [!warning] Starting point, not the source of truth
> This is raw origin material kept for historical reference — it is **not** edited, translated, or kept in sync with what actually ships. The organized vault (design specs, ADRs, conventions, the milestone plan note) is the source of truth. Where this text and a vault spec disagree, the vault spec wins.

---

## Original text (verbatim, Spanish)

```markdown
# Migración de *.sh a python scripts

## Objetivo
Todos los scripts que se creen de ahora en adelante deberán ser escritos en python por su extensibilidad y personalización. Asi mismo los actuales bash script deberan ser migrados a python o javascript (dependiendo del caso), de existir una limitación en los primeros hacerlo en bash script (.sh).

## Descripción
Migrar todos los actuales scripts de bash script en python, así mismo endurecer las cuales convenciones para siempre crear script usando python  en lo correspondiente a infraestructura, como pre effects y post effects, asimismo de existir alguna limitación clara en esta regla hacerlo como bash script pero priorizar primeramente hacerlo en python y secundariamente en javascript, y finalmente en bash script. Incluir en el vault esta nueva convención y de igual manera considerarlo en los archivos como CLAUDE.md de forma que no sea ignorado entre múltiples sesiones.

La elección de si un script debe ser hecho en python o javascript o bash va ser considerando aspectos de flexibilidad, personalización, readability, performance, escalabilidad a largo plazo.

## Entregables
- Migración completa de archivos .sh a scripts de python o javascript o como bash script.
- Documentar esto como una convención, crear ese harness en el vault y referenciar en donde sea necesario CLAUDE.md de forma que no se pierda entre sesiones.

# Mejora en los logs e implementación de tracing

## Objetivo
Mejorar la actual implementación de logs haciendo uso de un contexto y tracing que nos ayude a detectar acciones usando los niveles ya establecidos de info, error, warning, critical, etc en los REST endpoints y gRPC handlers, asimismo también crear un tracing a traves de microservicios. 

## Descripción
Implementación de un contexto en el logging que nos permita tener los siguientes valores (de estar disponibles)
- user_id
- cognito_sub
- email
- order_id
- tracking_id (pendiente de incluir cuando el servicio sea escrito, actualmente dejarlo como pendiente)
- type (pendiente de incluir cuando el servicio events-pipeline)

El sentido de tener todo esto dentro de un contexto es proveer al usuario la habilidad de poner hacer algo como filtrar todo los logs o tráfico de un usuario en específico basado en user_email, user_id, cognito_sub u order, cabe considerar que por ejemplo en acciones como login, register, cosas como el user_id no van a estar disponibles, sin embargo puede extraerse dicho valor del email que está mandando el usuario en su body, podemos hacer un interceptor para esto mismo. 

También incluir en el contexto duration_s (duration in seconds) a las actuales logs por cada servicio.

Incluir nuevos logs en cada endpoint de principio a fin, por ejemplo cosas como en registro de usuario tener logs como:
- [INFO] Starting user registration using email: <@body_email>
- [SUCCESS] User registration completed using <@body_email>. UserId assigned <@user_id>
- [ERROR] User registration failed: User with email <@body_email> already exists in the database.
- [ERROR] User registration failed: User with email <@body_email> didn't provide a valid password.
- [ERROR] User registration failed: An error occurred trying to create the user in cognito using email <@body_email>.
- [ERROR] User registration failed: An error occurred trying to create the user in our database using email <@body_email>.

El punto es proveer logs que nos permitan visualizar flujos, lo que se intentó hacer, el resultado de ser exitoso o fallido. Lo que no deberíamos hacer es exponer información sensible como los passwords en los logs. Hacer esto en todos los microservicios que se hagan y documentarlo como una convención.

Estandarización de logs en todos los servicios, el contexto deberá contener los mismos fields en todos los servicios a modo de no presentar diferencias entre los mismos.

Implementación de tracing en flujos complejos por ejemplo un usuario crea una nueva orden y eso invoca un inicio de tracking con status de SHIPPED (esto ultimo aun no está implementando pero es para ver un flujo que abarca más de un servicio) 

## Entregables
- Modificación de logs actuales, de momento podemos quitar los logs de request started y completed que existen puesto que son diferentes entre ambos servicios mapeados. Deberíamos estandarizar la misma.
- Incluir nuevos logs como los descritos anteriormente que agreguen valor a los flujos o procesos que se van hacer.
- Implementación de tracing compatible con la actual implementacion de open observe.
- Documentar esto como una convención, crear ese harness en el vault y referenciar en donde sea necesario CLAUDE.md de forma que no se pierda entre sesiones.

# Auto generación de Env Files

## Objetivo
Auto generar todos los env files que surgen del discovery de recursos creados mediante terraform tanto para la infraestructura, así también los generados para los microservicios.

## Descripción
Queremos generar tres tipos de env files:
- .env.<environment>.services: aquellos necesarios para los microservicios, los cuales estarán separados por secciones, la sección de Auto-Generated, Custom (que estos serían los que el usuario quiera agregar como por ejemplo custom PORT u otros, evalúa los actuales que se usan en el docker compose)
- .env.<environment>.infra, todos aquellos que surgen de la infraestructura como el cognito user pool id, cognito client id, api gateway url, etc.
- .env.<environment>.debug, aquellos que son usados para hacer debug en local, por ejemplo las cadenas de conexión a la base de datos para poder conectarme desde mi red (una red que existe fuera de la docker).

Analiza el actual .env para evaluar las variables y desarrollar el plan con mayor precisión. Considera los que actualmente son custom y dividelos en las siguientes categorías por microservicios algo como # >>> AUTO-GENERATED (Users) y # >>> CUSTOM (Users)

## Entregables
- Make env-file ahora también genera los .env anteriormente descritos con sus funciones y descripciones. Para los custom variables usemos un .env.example que pueda ser commiteado en git.
- Los microservicios actuales y test deberían seguir funcionando sin problema ni errores con el mismo comportamiento actual.
- Documentar esto como una convención, crear ese harness en el vault y referenciar en donde sea necesario CLAUDE.md de forma que no se pierda entre sesiones.
```

## Related

- [[2026-07-19-scripts-to-python-migration-design]]
- [[developer-experience-milestone]]
- [[first-prompt-en]]
