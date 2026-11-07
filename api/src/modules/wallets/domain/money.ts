import type { MoneyProps } from './money.props.js';
import {
  CurrencyMismatchError,
  InvalidCurrencyCodeError,
  InvalidMoneyAmountError,
} from './money.errors.js';

export class Money {
  private constructor(
    private readonly minorUnits: bigint,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    const currency = Money.validateCurrency(props.currency);
    const minorUnits = Money.parseAmount(props.amount);

    return new Money(minorUnits, currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.validateCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return (
      this.currency === other.currency &&
      this.minorUnits === other.minorUnits
    );
  }

  toJSON(): MoneyProps {
    return {
      amount: Money.formatMinorUnits(this.minorUnits),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${Money.formatMinorUnits(this.minorUnits)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static parseAmount(amount: string): bigint {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
    if (!match) {
      throw new InvalidMoneyAmountError();
    }

    const whole = BigInt(match[1]!);
    const fraction = BigInt((match[2] ?? '').padEnd(2, '0') || '0');
    return whole * 100n + fraction;
  }

  private static formatMinorUnits(minorUnits: bigint): string {
    const sign = minorUnits < 0n ? '-' : '';
    const absolute = minorUnits < 0n ? -minorUnits : minorUnits;
    const whole = absolute / 100n;
    const fraction = (absolute % 100n).toString().padStart(2, '0');

    return `${sign}${whole}.${fraction}`;
  }

  private static validateCurrency(currency: string): string {
    if (!/^[A-Z]{3}$/.test(currency)) {
      throw new InvalidCurrencyCodeError();
    }

    return currency;
  }
}
