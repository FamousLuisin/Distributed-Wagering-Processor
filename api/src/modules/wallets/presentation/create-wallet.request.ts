import { BadRequestException } from '@nestjs/common';
import {
  InvalidCurrencyCodeError,
  InvalidMoneyAmountError,
} from '../domain/money.errors.js';
import { Money } from '../domain/money.js';
import type { CreateWalletProps } from '../application/wallet-application.service.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCreateWalletRequest(body: unknown): CreateWalletProps {
  if (!isRecord(body)) throw invalidRequest('Request body must be a JSON object');
  if (typeof body.playerId !== 'string' || !UUID_PATTERN.test(body.playerId)) {
    throw invalidRequest('playerId must be a UUID');
  }
  if (!isRecord(body.initialBalance)) {
    throw invalidRequest('initialBalance must contain amount and currency');
  }
  if (
    typeof body.initialBalance.amount !== 'string' ||
    typeof body.initialBalance.currency !== 'string'
  ) {
    throw invalidRequest('initialBalance.amount and currency must be strings');
  }

  try {
    const money = Money.from({
      amount: body.initialBalance.amount,
      currency: body.initialBalance.currency,
    });
    if (money.isNegative()) {
      throw invalidRequest('initialBalance.amount cannot be negative');
    }
    const integerDigits = body.initialBalance.amount
      .split('.')[0]!
      .replace(/^0+/, '').length;
    if (integerDigits > 18) {
      throw invalidRequest('initialBalance.amount exceeds supported precision');
    }
    return { playerId: body.playerId, initialBalance: money.toJSON() };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    if (
      error instanceof InvalidMoneyAmountError ||
      error instanceof InvalidCurrencyCodeError
    ) {
      throw invalidRequest(error.message);
    }
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidRequest(message: string): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    code: 'INVALID_REQUEST',
    message,
  });
}
