import { Module } from '@nestjs/common';
import { OutboxPublisher } from './application/outbox-publisher.js';
import {
  createSqsClient,
  SQS_CLIENT,
  SQS_CONSUMER_CLIENT,
} from './infrastructure/sqs-client.provider.js';
import { SqsWagerConsumer } from './application/sqs-wager-consumer.js';
import { WageringModule } from '../wagering/wagering.module.js';

@Module({
  imports: [WageringModule],
  providers: [
    { provide: SQS_CLIENT, useFactory: createSqsClient },
    { provide: SQS_CONSUMER_CLIENT, useFactory: createSqsClient },
    OutboxPublisher,
    SqsWagerConsumer,
  ],
  exports: [OutboxPublisher],
})
export class MessagingModule {}
