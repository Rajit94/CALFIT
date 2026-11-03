
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module.js';
import type { Env } from './config/env.schema.js';
import { createRequestLogger } from './common/logging/request-logger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // Log HTTP requests and attach a request ID.
  app.use(createRequestLogger());

  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();

  const config = app.get<ConfigService<Env, true>>(ConfigService);

  // API docs are for development only; they are not served in production.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('CALFIT API')
        .setDescription('Backend API for the CALFIT gym management and social app')
        .setVersion('0.1.0')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(config.get('PORT', { infer: true }));
}

void bootstrap();
