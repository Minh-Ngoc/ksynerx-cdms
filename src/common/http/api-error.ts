import { BadRequestException, ValidationPipe, ValidationError } from '@nestjs/common';

export enum ErrorCode {
  ValidationError = 'VALIDATION_ERROR',
  NotFound = 'NOT_FOUND',
  Conflict = 'CONFLICT',
  DependencyUnavailable = 'DEPENDENCY_UNAVAILABLE',
  InternalError = 'INTERNAL_ERROR',
}

export interface ApiErrorResponse {
  statusCode: number;
  code: ErrorCode;
  message: string | string[];
  path?: string;
  timestamp?: string;
}

function flattenValidationMessages(errors: ValidationError[]): string[] {
  const messages = errors.flatMap((error) => {
    const ownMessages = Object.values(error.constraints ?? {});
    const childMessages = flattenValidationMessages(error.children ?? []);
    return [...ownMessages, ...childMessages];
  });

  return messages.length > 0 ? messages : ['Request validation failed'];
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    transform: true,
    whitelist: true,
    forbidNonWhitelisted: true,
    forbidUnknownValues: true,
    validationError: {
      target: false,
      value: false,
    },
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({
        statusCode: 400,
        code: ErrorCode.ValidationError,
        message: flattenValidationMessages(errors),
      } satisfies ApiErrorResponse),
  });
}
