import type { ArchitectureData } from "../../schema";

// CONTRACT: zones are container boundaries, ordered so every edge joins the same or an adjacent zone.
// Sources: infra/modules/{api-gateway,cognito,messaging,lambda}, services/*/openapi.yaml.
export const systemContextL2: ArchitectureData = {
  title: "System context — Level 2 (containers)",
  subtitle: "API Gateway reaches the services through nginx (dev) or the ALB (pre-prod)",
  zones: [
    { id: "people", label: "People" },
    { id: "edge", label: "Edge" },
    { id: "services", label: "Service containers" },
    { id: "stores", label: "Stores + topic" },
    { id: "pipeline", label: "Event pipeline" },
  ],
  nodes: [
    { id: "customer", label: "Customer", kind: "external", zone: "people" },
    { id: "web", label: "Web app (Angular)", kind: "compute", zone: "edge" },
    { id: "cognito", label: "Cognito", kind: "edge", aws: "cognito", zone: "edge" },
    { id: "apigw", label: "API Gateway", kind: "edge", aws: "api-gateway", zone: "edge" },
    { id: "orders", label: "Orders (.NET)", kind: "compute", zone: "services" },
    { id: "users", label: "Users (Node.js)", kind: "compute", zone: "services" },
    { id: "tracking", label: "Tracking (Go)", kind: "compute", zone: "services" },
    { id: "pg", label: "Users DB (Postgres)", kind: "data", aws: "rds", zone: "stores" },
    { id: "mysql", label: "Orders + Tracking DB", kind: "data", aws: "rds", zone: "stores" },
    { id: "sns", label: "SNS events topic", kind: "messaging", aws: "sns", zone: "stores" },
    { id: "events", label: "Events queue", kind: "messaging", aws: "sqs", zone: "pipeline" },
    { id: "lambda", label: "events-pipeline", kind: "compute", aws: "lambda", zone: "pipeline" },
    { id: "docdb", label: "Event store (DocDB)", kind: "data", aws: "documentdb", zone: "pipeline" },
  ],
  edges: [
    { from: "customer", to: "web", label: "HTTP" },
    { from: "web", to: "apigw", label: "proxy" },
    { from: "apigw", to: "cognito", label: "JWT" },
    { from: "apigw", to: "orders" },
    { from: "apigw", to: "users" },
    { from: "apigw", to: "tracking" },
    { from: "orders", to: "users", label: "gRPC" },
    { from: "tracking", to: "users", label: "gRPC" },
    { from: "users", to: "pg" },
    { from: "orders", to: "mysql" },
    { from: "tracking", to: "mysql" },
    { from: "users", to: "sns" },
    { from: "orders", to: "sns" },
    { from: "tracking", to: "sns" },
    { from: "sns", to: "events" },
    { from: "events", to: "lambda" },
    { from: "lambda", to: "docdb" },
  ],
};
