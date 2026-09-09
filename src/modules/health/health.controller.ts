import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';

import type { HealthResponse } from './dto/health-contracts.js';
import { HealthService } from './health.service.js';

@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get()
  async get(@Res({ passthrough: true }) response: Response): Promise<HealthResponse> {
    const health = await this.health.check();
    response.status(health.status === 'ok' ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return health;
  }
}
