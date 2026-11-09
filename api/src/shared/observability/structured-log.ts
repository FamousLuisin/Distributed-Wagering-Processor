import type { Logger } from '@nestjs/common';

export type StructuredLogLevel = 'debug' | 'log' | 'warn' | 'error';

interface LogFields {
  correlationId?: string;
  causationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  externalTransactionId?: string;
  status?: string;
  errorCode?: string;
  durationMs?: number;
  [key: string]: unknown;
}

export function logEvent(
  logger: Logger,
  level: StructuredLogLevel,
  component: string,
  event: string,
  fields: LogFields = {},
): void {
  const {
    correlationId,
    causationId,
    messageId,
    transactionId,
    walletId,
    providerId,
    externalTransactionId,
    status,
    errorCode,
    durationMs,
    ...extra
  } = fields;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    component,
    event,
    correlationId: correlationId ?? null,
    causationId: causationId ?? null,
    messageId: messageId ?? null,
    transactionId: transactionId ?? null,
    walletId: walletId ?? null,
    providerId: providerId ?? null,
    externalTransactionId: externalTransactionId ?? null,
    status: status ?? null,
    errorCode: errorCode ?? null,
    durationMs: durationMs ?? null,
    ...extra,
  };
  logger[level](JSON.stringify(record));
}
