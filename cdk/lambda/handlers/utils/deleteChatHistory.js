const { Logger } = require("@aws-lambda-powertools/logger");

const logger = new Logger({ serviceName: "DeleteChatHistory" });

/**
 * Delete all DynamoDB conversation sessions for a case.
 * Session IDs are stored as "{case_id}-{block_type}" (LangChain history table).
 *
 * @param {string} tableName - DynamoDB conversation table name
 * @param {string} caseId - Case UUID
 * @returns {Promise<number>} Number of sessions deleted
 */
async function deleteChatHistory(tableName, caseId) {
  const {
    DynamoDBClient,
    ScanCommand,
    BatchWriteItemCommand,
  } = await import("@aws-sdk/client-dynamodb");

  const client = new DynamoDBClient();
  const prefix = `${caseId}-`;
  let lastEvaluatedKey;
  let deletedCount = 0;

  do {
    const scanResult = await client.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression: "begins_with(SessionId, :prefix)",
        ExpressionAttributeValues: {
          ":prefix": { S: prefix },
        },
        ProjectionExpression: "SessionId",
        ExclusiveStartKey: lastEvaluatedKey,
      }),
    );

    const items = scanResult.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25);
      if (batch.length === 0) {
        continue;
      }

      await client.send(
        new BatchWriteItemCommand({
          RequestItems: {
            [tableName]: batch.map((item) => ({
              DeleteRequest: {
                Key: { SessionId: item.SessionId },
              },
            })),
          },
        }),
      );
      deletedCount += batch.length;
    }

    lastEvaluatedKey = scanResult.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  logger.info("Deleted conversation sessions for case", {
    caseId,
    deletedCount,
  });
  return deletedCount;
}

module.exports = { deleteChatHistory };
