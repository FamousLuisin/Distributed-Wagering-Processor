import { Module } from '@nestjs/common';
import { ProcessWager } from './application/process-wager.js';
import { WageringController } from './presentation/wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [ProcessWager],
  exports: [ProcessWager],
})
export class WageringModule {}
