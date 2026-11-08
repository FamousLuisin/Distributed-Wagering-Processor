import {
  ConflictException,
  Controller,
  BadRequestException,
  HttpStatus,
  NotFoundException,
  Post,
  Headers,
  Body,
  Res,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ExternalTransactionConflictError,
  IdempotencyConflictError,
  InvalidWagerAmountError,
  WalletNotFoundError,
  WalletOwnershipMismatchError,
  WagerCurrencyMismatchError,
} from '../application/process-wager.errors.js';
import { ProcessWager } from '../application/process-wager.js';
import { WagerTransactionStatus } from '../domain/wager-transaction.types.js';
import { parseSubmitWagerRequest } from './submit-wager.request.js';

@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly processWager: ProcessWager) {}

  @Post()
  async submitTransaction(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: unknown,
    @Res() response: Response,
  ) {
    const props = parseSubmitWagerRequest(body, idempotencyKey);

    try {
      const result = await this.processWager.execute(props);
      const statusCode =
        result.status === WagerTransactionStatus.PendingReference
          ? HttpStatus.ACCEPTED
          : HttpStatus.OK;
      return response.status(statusCode).json(result);
    } catch (error) {
      if (error instanceof IdempotencyConflictError) {
        throw new ConflictException({
          statusCode: 409,
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'Idempotency-Key was already used with a different request',
        });
      }
      if (error instanceof InvalidWagerAmountError) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'INVALID_WAGER_AMOUNT',
          message: 'Transaction amount must be greater than zero',
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
