export interface ReceiveInboxMessageProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt?: Date;
}

export interface InboxMessageState extends ReceiveInboxMessageProps {
  receivedAt: Date;
  processedAt?: Date;
}

export class InboxMessage {
  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    private readonly _receivedAt: Date,
    private _processedAt?: Date,
  ) {}

  static receive(props: ReceiveInboxMessageProps): InboxMessage {
    return InboxMessage.rehydrate({
      ...props,
      receivedAt: props.receivedAt ?? new Date(),
    });
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    for (const [field, value] of [
      ['messageId', state.messageId],
      ['consumerName', state.consumerName],
      ['payloadHash', state.payloadHash],
    ] as const) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${field} must not be empty`);
      }
    }
    InboxMessage.assertDate(state.receivedAt, 'receivedAt');
    if (state.processedAt) InboxMessage.assertDate(state.processedAt, 'processedAt');

    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get receivedAt(): Date {
    return new Date(this._receivedAt.getTime());
  }

  get processedAt(): Date | undefined {
    return this._processedAt ? new Date(this._processedAt.getTime()) : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    InboxMessage.assertDate(at, 'processedAt');
    if (this._processedAt) throw new Error('Inbox message is already processed');
    this._processedAt = new Date(at.getTime());
  }

  private static assertDate(value: Date, field: string): void {
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new Error(`${field} must be a valid date`);
    }
  }
}
