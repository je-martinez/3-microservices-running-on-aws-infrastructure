// CONTRACT: Every function here THROWS. Reach this module only through
// `publishToUser`, which is where the never-fail-the-persistence guarantee lives.
// Calling either function straight from a command puts an uncaught throw on the
// notification write path, and the row is then lost for a socket problem.
// See [[2026-09-10-in-app-notifications-design]]
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { envSchema, type Env } from "#config/env.schema";

export type ConnectionsConfig = Pick<
  Env,
  "AWS_REGION" | "AWS_ENDPOINT_URL" | "WS_CONNECTIONS_TABLE" | "WS_CONNECTIONS_GSI"
>;

export function createConnectionsReader(config: ConnectionsConfig) {
  let docClient: DynamoDBDocumentClient | null = null;

  // Built lazily so importing this module opens no connection — the unit suite
  // imports it transitively and must not reach a real endpoint.
  function client(): DynamoDBDocumentClient {
    if (docClient === null) {
      docClient = DynamoDBDocumentClient.from(
        new DynamoDBClient({ region: config.AWS_REGION, endpoint: config.AWS_ENDPOINT_URL }),
      );
    }
    return docClient;
  }

  /**
   * Every open connection for one user.
   *
   * CONTRACT: The argument MUST be a Cognito `sub`, never the internal `usr_` id.
   * The GSI is keyed by `cognito_sub`, so querying it with a `usr_` id returns an
   * empty list and NO error — which reads exactly like "the user has nothing open".
   * See [[user-id-vs-cognito-sub-ownership-key]]
   */
  async function queryByCognitoSub(cognitoSub: string): Promise<string[]> {
    const result = await client().send(
      new QueryCommand({
        TableName: config.WS_CONNECTIONS_TABLE,
        IndexName: config.WS_CONNECTIONS_GSI,
        KeyConditionExpression: "cognito_sub = :s",
        ExpressionAttributeValues: { ":s": cognitoSub },
        ProjectionExpression: "connection_id",
      }),
    );
    return (result.Items ?? []).map((item) => String(item.connection_id));
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    await client().send(
      new DeleteCommand({
        TableName: config.WS_CONNECTIONS_TABLE,
        Key: { connection_id: connectionId },
      }),
    );
  }

  return { queryByCognitoSub, deleteConnection };
}

// CONTRACT: Resolve LAZILY. Parsing the environment at module-eval time kills
// the process on import, before Nest can report which variable is missing, and
// forces every test that merely imports this module to supply a full
// environment.
// CONTRACT: Temporary bridge. It disappears once a Nest module provides this;
// nothing new may import it.
let bridge: ReturnType<typeof createConnectionsReader> | undefined;

function resolveBridge(): ReturnType<typeof createConnectionsReader> {
  bridge ??= createConnectionsReader(envSchema.parse(process.env));
  return bridge;
}

export const queryByCognitoSub: ReturnType<typeof createConnectionsReader>["queryByCognitoSub"] = (
  ...args
) => resolveBridge().queryByCognitoSub(...args);

export const deleteConnection: ReturnType<typeof createConnectionsReader>["deleteConnection"] = (
  ...args
) => resolveBridge().deleteConnection(...args);
