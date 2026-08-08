// EVERY function in this module THROWS on failure — deliberately, and this is
// the one thing to know before calling it.
//
// The realtime push is contractually not allowed to fail an event (a
// propagating error would make SQS retry the record and send the user a second
// email for a transition they were already notified about). That guarantee is
// NOT implemented here: it lives entirely in `websocket-publisher.ts`, whose
// `publishToUser` wraps every call into this module in try/catch.
//
// So: reach this module THROUGH `publishToUser`. Calling `queryByCognitoSub` or
// `deleteConnection` directly from a handler re-introduces a throw path into
// the pipeline with nothing to catch it, and the failure would look like a
// broken event rather than a failed notification.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

let docClient: DynamoDBDocumentClient | null = null;

function client(): DynamoDBDocumentClient {
  if (docClient === null) {
    docClient = DynamoDBDocumentClient.from(
      new DynamoDBClient({
        region: process.env.AWS_REGION ?? "us-east-1",
        ...(process.env.AWS_ENDPOINT_URL
          ? { endpoint: process.env.AWS_ENDPOINT_URL }
          : {}),
      }),
    );
  }
  return docClient;
}

/**
 * Every open connection for one user.
 *
 * Queries the `by-cognito-sub` GSI. The argument MUST be a Cognito `sub` — the
 * envelope's `user_id` is the internal `usr_` id and querying with it returns
 * an empty list with no error whatsoever, which reads exactly like "user has no
 * connections". See the user-id-vs-cognito-sub-ownership-key ADR.
 */
export async function queryByCognitoSub(cognitoSub: string): Promise<string[]> {
  const result = await client().send(
    new QueryCommand({
      TableName: process.env.WS_CONNECTIONS_TABLE,
      IndexName: process.env.WS_CONNECTIONS_GSI ?? "by-cognito-sub",
      KeyConditionExpression: "cognito_sub = :s",
      ExpressionAttributeValues: { ":s": cognitoSub },
      ProjectionExpression: "connection_id",
    }),
  );
  return (result.Items ?? []).map((item) => String(item.connection_id));
}

export async function deleteConnection(connectionId: string): Promise<void> {
  await client().send(
    new DeleteCommand({
      TableName: process.env.WS_CONNECTIONS_TABLE,
      Key: { connection_id: connectionId },
    }),
  );
}
