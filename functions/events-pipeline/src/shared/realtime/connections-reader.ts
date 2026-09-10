// CONTRACT: Every function here THROWS. Reach this module only through
// `publishToUser`, which is where the never-fail-an-event guarantee lives.
// Calling `queryByCognitoSub` or `deleteConnection` straight from a handler puts
// an uncaught throw back in the pipeline, and SQS then retries the record and
// sends a SECOND email for a transition the user was already notified about.
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
 * CONTRACT: The argument MUST be a Cognito `sub`, never the envelope's internal
 * `usr_` id — querying with the wrong one returns an empty list and no error,
 * which reads exactly like "the user has no connections".
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
