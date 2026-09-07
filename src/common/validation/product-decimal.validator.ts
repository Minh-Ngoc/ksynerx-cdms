import { registerDecorator, ValidationOptions } from 'class-validator';

const NUMERIC_18_2_PATTERN = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;

export function IsProductDecimal(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isProductDecimal',
      target: target.constructor,
      propertyName: String(propertyName),
      options: {
        message:
          '$property must be a non-negative decimal string compatible with NUMERIC(18,2)',
        ...validationOptions,
      },
      validator: {
        validate(value: unknown): boolean {
          // Price stays as a string because converting through Number can change decimal identity
          // before canonical fingerprinting has a chance to compare exact product states.
          return typeof value === 'string' && NUMERIC_18_2_PATTERN.test(value);
        },
      },
    });
  };
}

export const productDecimalPattern = NUMERIC_18_2_PATTERN;
