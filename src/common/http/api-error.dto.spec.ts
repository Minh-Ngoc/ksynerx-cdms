import { BadRequestException, ValidationPipe } from '@nestjs/common';

import { createValidationPipe, ErrorCode } from './api-error.js';

describe('stable API error shape', () => {
  it('maps validation failures to a stable external error contract', () => {
    const pipe = createValidationPipe();

    expect(pipe).toBeInstanceOf(ValidationPipe);

    const exceptionFactory = Reflect.get(pipe, 'exceptionFactory') as (errors: unknown[]) => BadRequestException;
    const exception = exceptionFactory([]);

    expect(exception.getResponse()).toEqual({
      statusCode: 400,
      code: ErrorCode.ValidationError,
      message: ['Request validation failed'],
    });
  });
});
