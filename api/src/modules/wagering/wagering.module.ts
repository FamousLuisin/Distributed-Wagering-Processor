import { Module } from '@nestjs/common';
import { ProcessBet } from './application/process-bet.js';
import { WageringController } from './presentation/wagering.controller.js';

@Module({
  controllers: [WageringController],
  providers: [ProcessBet],
  exports: [ProcessBet],
})
export class WageringModule {}
