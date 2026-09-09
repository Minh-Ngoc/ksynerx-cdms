import { Controller, Get, HttpCode, HttpStatus, Param, Post, Req, Sse, SseSignal } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { ImportCreateResponse, type ImportStatusResponse } from './dto/import-contracts.js';
import { ImportProgressReadService } from './import-progress-read.service.js';
import { ImportUploadService } from './import-upload.service.js';

@Controller('imports')
export class ImportsController {
  constructor(
    private readonly imports: ImportUploadService,
    private readonly progress: ImportProgressReadService,
  ) {}

  @Post('products')
  @HttpCode(HttpStatus.ACCEPTED)
  async upload(@Req() request: Request): Promise<ImportCreateResponse> {
    return this.imports.accept(request);
  }

  @Get(':id')
  async getStatus(@Param('id') importId: string): Promise<ImportStatusResponse> {
    return this.progress.getStatus(importId);
  }

  @Sse(':id/progress')
  async streamProgress(@Param('id') importId: string, @SseSignal() signal: AbortSignal): Promise<Observable<MessageEvent>> {
    return this.progress.stream(importId, signal);
  }
}
