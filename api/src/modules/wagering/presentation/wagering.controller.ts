import {
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Headers,
  Body,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from '../application/process-bet.errors.js';
import { ProcessBet } from '../application/process-bet.js';
import { parseSubmitBetRequest } from './submit-bet.request.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processBet: ProcessBet) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  async submitBet(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
  ) {
    const props = parseSubmitBetRequest(body, idempotencyKey);

    try {
      return await this.processBet.execute(props);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          statusCode: 409,
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency-Key was already used with a different request',
        });
      }
      if (error instanceof ExternalTransactionConflictError) {
        throw new ConflictException({
          statusCode: 409,
          code: 'EXTERNAL_TRANSACTION_CONFLICT',
          message: 'Provider transaction ID was already used',
        });
      }
      if (error instanceof WalletNotFoundError) {
        throw new NotFoundException({
          statusCode: 404,
          code: 'WALLET_NOT_FOUND',
          message: 'Wallet was not found',
        });
      }
      if (error instanceof WalletOwnershipMismatchError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'WALLET_PLAYER_MISMATCH',
          message: 'Wallet does not belong to the submitted player',
        });
      }
      if (error instanceof WagerCurrencyMismatchError) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'WALLET_CURRENCY_MISMATCH',
          message: 'Wager currency does not match wallet currency',
        });
      }
      throw error;
    }
  }
}
