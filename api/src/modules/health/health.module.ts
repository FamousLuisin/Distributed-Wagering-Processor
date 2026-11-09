import { Module } from '@nestjs/common';
import { HealthController } from './presentation/health.controller.js';
import { MessagingModule } from '../messaging/messaging.module.js';

@Module({
  imports: [MessagingModule],
  controllers: [HealthController],
})
export class HealthModule {}
