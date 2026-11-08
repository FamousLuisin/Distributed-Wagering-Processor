import { SQSClient } from '@aws-sdk/client-sqs';

export const SQS_CLIENT = Symbol('SQS_CLIENT');
export const SQS_CONSUMER_CLIENT = Symbol('SQS_CONSUMER_CLIENT');

export function createSqsClient(): SQSClient {
  const endpoint = process.env.SQS_ENDPOINT;
  return new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    maxAttempts: 2,
    ...(endpoint
      ? {
          endpoint,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
          },
        }
      : {}),
  });
}
