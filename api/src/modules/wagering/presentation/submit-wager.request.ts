import { BadRequestException } from '@nestjs/common';
import {
  InvalidCurrencyCodeError,
  InvalidMoneyAmountError,
} from '../../wallets/domain/money.errors.js';
import { Money } from '../../wallets/domain/money.js';
import type { ProcessWagerProps } from '../application/process-wager.types.js';
import { WagerTransactionKind } from '../domain/wager-transaction.types.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseSubmitWagerRequest(
  body: unknown,
  idempotencyKey: string | undefined,
): ProcessWagerProps {
  if (!isRecord(body)) {
    throw invalidRequest('Request body must be a JSON object');
  }

  const key = requiredText(idempotencyKey, 'Idempotency-Key', 255);
  const providerId = requiredText(body.providerId, 'providerId', 128);
  const externalTransactionId = requiredText(
    body.externalTransactionId,
    'externalTransactionId',
    255,
  );
  const playerId = requiredText(body.playerId, 'playerId', 36);
  const walletId = requiredText(body.walletId, 'walletId', 36);
  const roundId = requiredText(body.roundId, 'roundId', 255);
  const gameId = requiredText(body.gameId, 'gameId', 255);

  if (!UUID_PATTERN.test(playerId))
    throw invalidRequest('playerId must be a UUID');
  if (!UUID_PATTERN.test(walletId))
    throw invalidRequest('walletId must be a UUID');
  if (!isExternalKind(body.kind)) {
    throw invalidRequest('kind must be BET, WIN, LOSS, REFUND, or ROLLBACK');
  }
  const kind = body.kind;
  const referenceExternalTransactionId =
    body.referenceExternalTransactionId === undefined
      ? undefined
      : requiredText(
          body.referenceExternalTransactionId,
          'referenceExternalTransactionId',
          255,
        );

  if (
    (kind === WagerTransactionKind.Refund ||
      kind === WagerTransactionKind.Rollback) &&
    !referenceExternalTransactionId
  ) {
    throw invalidRequest(`${kind} requires referenceExternalTransactionId`);
  }
  if (kind === WagerTransactionKind.Bet && referenceExternalTransactionId) {
    throw invalidRequest('BET cannot contain referenceExternalTransactionId');
  }
  if (!isRecord(body.money)) {
    throw invalidRequest('money must contain amount and currency');
  }

  const amount = requiredText(body.money.amount, 'money.amount', 64);
  const currency = requiredText(body.money.currency, 'money.currency', 3);
  let money: Money;
  try {
    money = Money.from({ amount, currency });
  } catch (error) {
    if (
      error instanceof InvalidMoneyAmountError ||
      error instanceof InvalidCurrencyCodeError
    ) {
      throw invalidRequest(error.message);
    }
    throw error;
  }

  if (!money.isPositive()) {
    throw invalidRequest('Transaction amount must be greater than zero');
  }
  const integerDigits = amount.split('.')[0]!.replace(/^0+/, '').length;
  if (integerDigits > 18) {
    throw invalidRequest('money.amount exceeds the supported precision');
  }

  return {
    providerId,
    externalTransactionId,
    idempotencyKey: key,
    playerId,
    walletId,
    roundId,
    gameId,
    kind,
    money: money.toJSON(),
    ...(referenceExternalTransactionId
      ? { referenceExternalTransactionId }
      : {}),
  };
}

function isExternalKind(value: unknown): value is ProcessWagerProps['kind'] {
  return (
    value === WagerTransactionKind.Bet ||
    value === WagerTransactionKind.Win ||
    value === WagerTransactionKind.Loss ||
    value === WagerTransactionKind.Refund ||
    value === WagerTransactionKind.Rollback
  );
}

function requiredText(
  value: unknown,
  field: string,
  maxLength: number,
): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw invalidRequest(`${field} is required`);
  }
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw invalidRequest(
      `${field} must contain at most ${maxLength} characters`,
    );
  }
  return normalized;
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
