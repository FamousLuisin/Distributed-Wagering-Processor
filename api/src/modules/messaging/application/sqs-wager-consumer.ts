import { createHash } from 'node:crypto';
import type { Message } from '@aws-sdk/client-sqs';
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { HttpException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { InboxMessageEntity } from '../infrastructure/inbox-message.entity.js';
import {
  SQS_CONSUMER_CLIENT,
} from '../infrastructure/sqs-client.provider.js';
import { ProcessWager } from '../../wagering/application/process-wager.js';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InboxMessagePayloadConflictError,
  InboxMessageWithoutWagerError,
  InvalidWagerAmountError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from '../../wagering/application/process-wager.errors.js';
import { parseSubmitWagerRequest } from '../../wagering/presentation/submit-wager.request.js';
import type { ProcessWagerProps } from '../../wagering/application/process-wager.types.js';

interface DecodedWagerMessage {
  props: ProcessWagerProps;
  inbox: NonNullable<ProcessWagerProps['inboxMessage']>;
}

class InvalidQueueMessageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidQueueMessageError';
  }
}

@Injectable()
export class SqsWagerConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private static readonly CONSUMER_NAME = 'wager-transaction-consumer';
  private static readonly VISIBILITY_TIMEOUT_SECONDS = 60;
  private static readonly VISIBILITY_HEARTBEAT_MS = 30_000;
  private readonly logger = new Logger(SqsWagerConsumer.name);
  private readonly queueUrl = process.env.SQS_TRANSACTIONS_QUEUE_URL?.trim();
  private readonly deadLetterQueueUrl =
    process.env.SQS_TRANSACTIONS_DLQ_QUEUE_URL?.trim();
  private stopping = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly em: EntityManager,
    private readonly processWager: ProcessWager,
    @Inject(SQS_CONSUMER_CLIENT) private readonly sqs: SQSClient,
  ) {
    if (this.queueUrl && !this.queueUrl.endsWith('.fifo')) {
      throw new Error('SQS_TRANSACTIONS_QUEUE_URL must point to a FIFO queue');
    }
    if (this.deadLetterQueueUrl && !this.deadLetterQueueUrl.endsWith('.fifo')) {
      throw new Error('SQS_TRANSACTIONS_DLQ_QUEUE_URL must point to a FIFO queue');
    }
  }

  onApplicationBootstrap(): void {
    if (!this.queueUrl) {
      this.logger.warn(
        JSON.stringify({
          event: 'wager_consumer_disabled',
          reason: 'SQS_TRANSACTIONS_QUEUE_URL is not configured',
        }),
      );
      return;
    }
    this.loopPromise = this.runLoop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.loopPromise;
    this.sqs.destroy();
  }

  private async runLoop(): Promise<void> {
    const queueUrl = this.queueUrl;
    if (!queueUrl) return;
    while (!this.stopping) {
      try {
        const response = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: 20,
            VisibilityTimeout: SqsWagerConsumer.VISIBILITY_TIMEOUT_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          }),
        );
        const message = response.Messages?.[0];
        if (message) await this.handleMessage(message);
      } catch (error) {
        this.logger.error(
          JSON.stringify({
            event: 'wager_consumer_poll_failed',
            error: this.errorName(error),
          }),
        );
        await this.delay(1_000);
      }
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (!message.ReceiptHandle || message.Body === undefined) {
      this.logger.error(
        JSON.stringify({
          event: 'wager_message_missing_receipt_or_body',
          sqsMessageId: message.MessageId,
        }),
      );
      return;
    }

    const payloadHash = createHash('sha256').update(message.Body).digest('hex');
    let decoded: DecodedWagerMessage;
    try {
      decoded = this.decodeMessage(message.Body, payloadHash);
    } catch (error) {
      await this.sendPermanentMessageToDlq(message, this.errorName(error));
      return;
    }

    const heartbeat = setInterval(() => {
      void this.extendVisibility(message).catch((error: unknown) => {
        this.logger.warn(
          JSON.stringify({
            event: 'wager_message_visibility_extension_failed',
            messageId: decoded.inbox.messageId,
            error: this.errorName(error),
          }),
        );
      });
    }, SqsWagerConsumer.VISIBILITY_HEARTBEAT_MS);

    try {
      const previous = await this.em.fork({ clear: true }).findOne(
        InboxMessageEntity,
        {
          consumerName: decoded.inbox.consumerName,
          messageId: decoded.inbox.messageId,
        },
      );
      if (previous) {
        if (previous.payloadHash !== decoded.inbox.payloadHash) {
          await this.sendPermanentMessageToDlq(
            message,
            'INBOX_MESSAGE_ID_PAYLOAD_CONFLICT',
          );
          return;
        }
        if (previous.processedAt) {
          await this.acknowledge(message);
          this.logger.log(
            JSON.stringify({
              event: 'wager_message_duplicate_acknowledged',
              messageId: decoded.inbox.messageId,
            }),
          );
          return;
        }
      }

      try {
        const result = await this.processWager.execute(decoded.props);
        await this.acknowledge(message);
        this.logger.log(
          JSON.stringify({
            event: 'wager_message_processed',
            messageId: decoded.inbox.messageId,
            transactionId: result.transactionId,
            status: result.status,
          }),
        );
      } catch (error) {
        if (this.isTerminalBusinessError(error)) {
          await this.processWager.recordTerminalInboxMessage(decoded.inbox);
          await this.acknowledge(message);
          this.logger.warn(
            JSON.stringify({
              event: 'wager_message_terminal_business_error',
              messageId: decoded.inbox.messageId,
              error: this.errorName(error),
            }),
          );
          return;
        }
        if (error instanceof InboxMessagePayloadConflictError) {
          await this.sendPermanentMessageToDlq(message, error.name);
          return;
        }
        if (error instanceof InboxMessageWithoutWagerError) {
          await this.sendPermanentMessageToDlq(message, error.name);
          return;
        }
        await this.retryLater(message, error);
      }
    } catch (error) {
      await this.retryLater(message, error);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private decodeMessage(body: string, payloadHash: string): DecodedWagerMessage {
    let value: unknown;
    try {
      value = JSON.parse(body) as unknown;
    } catch {
      throw new InvalidQueueMessageError('Body is not valid JSON');
    }
    if (!this.isRecord(value)) {
      throw new InvalidQueueMessageError('Message envelope must be an object');
    }
    if (
      typeof value.messageId !== 'string' ||
      value.messageId.trim().length === 0 ||
      value.messageId.length > 128
    ) {
      throw new InvalidQueueMessageError('messageId must be a non-empty string up to 128 characters');
    }
    if (value.type !== 'WagerTransactionRequested') {
      throw new InvalidQueueMessageError('Unsupported message type');
    }
    if (
      typeof value.occurredAt !== 'string' ||
      Number.isNaN(Date.parse(value.occurredAt))
    ) {
      throw new InvalidQueueMessageError('occurredAt must be a valid timestamp');
    }

    const data = value.data;
    const idempotencyKey = this.isRecord(data)
      ? data.idempotencyKey
      : undefined;
    let props: ProcessWagerProps;
    try {
      props = parseSubmitWagerRequest(data, this.asString(idempotencyKey));
    } catch (error) {
      if (error instanceof HttpException) {
        throw new InvalidQueueMessageError('Message data does not match the wager contract');
      }
      throw error;
    }

    const messageId = value.messageId.trim();
    const inbox = {
      messageId,
      consumerName: SqsWagerConsumer.CONSUMER_NAME,
      payloadHash,
      receivedAt: new Date(),
    };
    return {
      inbox,
      props: {
        ...props,
        correlationId:
          typeof value.correlationId === 'string' && value.correlationId.trim()
            ? value.correlationId
            : messageId,
        causationId: messageId,
        inboxMessage: inbox,
      },
    };
  }

  private async acknowledge(message: Message): Promise<void> {
    if (!this.queueUrl || !message.ReceiptHandle) return;
    await this.sqs.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }

  private async extendVisibility(message: Message): Promise<void> {
    if (!this.queueUrl || !message.ReceiptHandle) return;
    await this.sqs.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.ReceiptHandle,
        VisibilityTimeout: SqsWagerConsumer.VISIBILITY_TIMEOUT_SECONDS,
      }),
    );
  }

  private async retryLater(message: Message, error: unknown): Promise<void> {
    if (!this.queueUrl || !message.ReceiptHandle) return;
    const receiveCount = Number.parseInt(
      message.Attributes?.ApproximateReceiveCount ?? '1',
      10,
    );
    const delaySeconds = Math.min(2 ** Math.max(receiveCount - 1, 0), 60);
    try {
      await this.sqs.send(
        new ChangeMessageVisibilityCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: message.ReceiptHandle,
          VisibilityTimeout: delaySeconds,
        }),
      );
    } catch (visibilityError) {
      this.logger.warn(
        JSON.stringify({
          event: 'wager_message_retry_visibility_failed',
          sqsMessageId: message.MessageId,
          error: this.errorName(visibilityError),
        }),
      );
    }
    this.logger.error(
      JSON.stringify({
        event: 'wager_message_retry_scheduled',
        sqsMessageId: message.MessageId,
        receiveCount,
        delaySeconds,
        error: this.errorName(error),
      }),
    );
  }

  private async sendPermanentMessageToDlq(
    message: Message,
    failureCode: string,
  ): Promise<void> {
    if (!this.queueUrl || !message.ReceiptHandle || message.Body === undefined) return;
    if (!this.deadLetterQueueUrl) {
      await this.retryLater(message, new Error(failureCode));
      return;
    }
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.deadLetterQueueUrl,
          MessageBody: message.Body,
          MessageGroupId:
            message.Attributes?.MessageGroupId ??
            `invalid-${message.MessageId ?? 'unknown'}`,
          MessageDeduplicationId:
            message.MessageId ??
            createHash('sha256').update(message.Body).digest('hex'),
          MessageAttributes: {
            failureCode: { DataType: 'String', StringValue: failureCode.slice(0, 128) },
          },
        }),
      );
      await this.acknowledge(message);
      this.logger.warn(
        JSON.stringify({
          event: 'wager_message_sent_to_dlq',
          sqsMessageId: message.MessageId,
          failureCode,
        }),
      );
    } catch (error) {
      await this.retryLater(message, error);
    }
  }

  private isTerminalBusinessError(error: unknown): boolean {
    return (
      error instanceof IdempotencyConflictError ||
      error instanceof ExternalTransactionConflictError ||
      error instanceof InvalidWagerAmountError ||
      error instanceof WalletNotFoundError ||
      error instanceof WalletOwnershipMismatchError ||
      error instanceof WagerCurrencyMismatchError
    );
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private errorName(error: unknown): string {
    return error instanceof Error ? error.name.slice(0, 128) : 'UnknownError';
  }

  private async delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
