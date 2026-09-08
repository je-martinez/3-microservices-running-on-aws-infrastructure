import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { getEnv } from "#shared/config/env";

// Two hours: API Gateway's hard cap on a WebSocket connection's lifetime, so a
// row older than this cannot be live.
// CONTRACT: A safety net, not the cleanup mechanism. Real cleanup is reactive —
// the events-pipeline deletes a row when PostToConnection answers 410 Gone.
// DynamoDB TTL can lag up to 48 hours, far too loose to rely on.
export const TTL_SECONDS = 7200;

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (docClient === null) {
    const env = getEnv();
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: env.awsRegion,
        ...(env.dynamoEndpoint ? { endpoint: env.dynamoEndpoint } : {}),
      }),
    );
  }
  return docClient;
}

export async function saveConnection(
  connectionId: string,
  cognitoSub: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await client().send(
    new PutCommand({
      TableName: getEnv().tableName,
      Item: {
        connection_id: connectionId,
        cognito_sub: cognitoSub,
        connected_at: now,
        ttl: now + TTL_SECONDS,
      },
    }),
  );
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client().send(
    new DeleteCommand({
      TableName: getEnv().tableName,
      Key: { connection_id: connectionId },
    }),
  );
}
