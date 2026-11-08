import { Module } from '@nestjs/common';
import { ProcessBet } from './application/process-bet.js';

@Module({
  providers: [ProcessBet],
  exports: [ProcessBet],
})
export class WageringModule {}
