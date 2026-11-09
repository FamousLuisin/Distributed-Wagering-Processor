import { Module } from '@nestjs/common';
import { ProcessWager } from './application/process-wager.js';
import { WageringController } from './presentation/wagering.controller.js';
import { WagerTransactionQueryController } from './presentation/wager-transaction-query.controller.js';
import { WagerTransactionQueryService } from './application/wager-transaction-query.service.js';

@Module({
  controllers: [WageringController, WagerTransactionQueryController],
  providers: [ProcessWager, WagerTransactionQueryService],
  exports: [ProcessWager],
})
export class WageringModule {}
