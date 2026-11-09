import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
} from '@nestjs/common';
import {
  WagerTransactionNotFoundError,
  WagerTransactionQueryService,
} from '../application/wager-transaction-query.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller()
export class WagerTransactionQueryController {
  constructor(private readonly queries: WagerTransactionQueryService) {}

  @Get('wagering/transactions/:transactionId')
  async byId(@Param('transactionId') transactionId: string) {
    if (!UUID_PATTERN.test(transactionId)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_TRANSACTION_ID',
        message: 'transactionId must be a UUID',
      });
    }
    try {
      return await this.queries.byId(transactionId);
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        throw transactionNotFound();
      }
      throw error;
    }
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async byProviderExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    if (!providerId.trim() || providerId.length > 128) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_PROVIDER_ID',
        message: 'providerId must contain 1 to 128 characters',
      });
    }
    if (!externalTransactionId.trim() || externalTransactionId.length > 255) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_EXTERNAL_TRANSACTION_ID',
        message: 'externalTransactionId must contain 1 to 255 characters',
      });
    }
    try {
      return await this.queries.byProviderExternalId(
        providerId.trim(),
        externalTransactionId.trim(),
      );
    } catch (error) {
      if (error instanceof WagerTransactionNotFoundError) {
        throw transactionNotFound();
      }
      throw error;
    }
  }
}

function transactionNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'WAGER_TRANSACTION_NOT_FOUND',
    message: 'Wager transaction was not found',
  });
}
