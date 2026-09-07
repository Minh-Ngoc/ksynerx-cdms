import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';
import { createValidationPipe } from './common/http/api-error.js';
import { AppConfigService } from './config/app-config.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(createValidationPipe());
  const appConfig = app.get(AppConfigService);
  await app.listen(appConfig.api.port);
}
await bootstrap();
