import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import {
  InvalidLedgerCursorError,
  WalletAlreadyExistsError,
  WalletApplicationService,
  WalletNotFoundError,
} from '../application/wallet-application.service.js';
import { parseCreateWalletRequest } from './create-wallet.request.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Controller('wallets')
export class WalletsController {
  constructor(private readonly wallets: WalletApplicationService) {}

  @Post()
  async create(@Body() body: unknown) {
    const props = parseCreateWalletRequest(body);
    try {
      return await this.wallets.create(props);
    } catch (error) {
      if (error instanceof WalletAlreadyExistsError) {
        throw new ConflictException({
          statusCode: 409,
          code: 'WALLET_ALREADY_EXISTS',
          message: 'A wallet already exists for this player and currency',
        });
      }
      throw error;
    }
  }

  @Get(':walletId')
  async get(@Param('walletId') rawWalletId: string) {
    const walletId = parseWalletId(rawWalletId);
    try {
      return await this.wallets.get(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw walletNotFound();
      throw error;
    }
  }

  @Get(':walletId/ledger')
  async ledger(
    @Param('walletId') rawWalletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    const walletId = parseWalletId(rawWalletId);
    if (cursor !== undefined && cursor.length > 512) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_LEDGER_CURSOR',
        message: 'cursor is invalid',
      });
    }
    const parsedLimit = limit === undefined ? 50 : Number.parseInt(limit, 10);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 100 ||
      (limit !== undefined && String(parsedLimit) !== limit)
    ) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'INVALID_LIMIT',
        message: 'limit must be an integer from 1 to 100',
      });
    }
    try {
      return await this.wallets.getLedger(walletId, {
        limit: parsedLimit,
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw walletNotFound();
      if (error instanceof InvalidLedgerCursorError) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'INVALID_LEDGER_CURSOR',
          message: 'cursor is invalid',
        });
      }
      throw error;
    }
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') rawWalletId: string) {
    const walletId = parseWalletId(rawWalletId);
    try {
      return await this.wallets.reconcile(walletId);
    } catch (error) {
      if (error instanceof WalletNotFoundError) throw walletNotFound();
      throw error;
    }
  }
}

function parseWalletId(walletId: string): string {
  if (!UUID_PATTERN.test(walletId)) {
    throw new BadRequestException({
      statusCode: 400,
      code: 'INVALID_WALLET_ID',
      message: 'walletId must be a UUID',
    });
  }
  return walletId;
}

function walletNotFound(): NotFoundException {
  return new NotFoundException({
    statusCode: 404,
    code: 'WALLET_NOT_FOUND',
    message: 'Wallet was not found',
  });
}
