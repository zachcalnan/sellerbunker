import { join } from 'path';
import * as dotenv from 'dotenv';
// Load .env from backend folder (works when run from backend/ or repo root)
dotenv.config({ path: join(process.cwd(), '.env') });
dotenv.config({ path: join(process.cwd(), 'backend', '.env') });

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const configService = app.get(ConfigService);

  app.useGlobalFilters(new AllExceptionsFilter());

  const rawBodyBuffer = (req: any, _res: any, buffer: Buffer, encoding?: string) => {
    if (req.headers['stripe-signature'] && buffer?.length) {
      req.rawBody = buffer;
    }
  };
  app.use(bodyParser.json({ verify: rawBodyBuffer }));
  app.use(bodyParser.urlencoded({ verify: rawBodyBuffer, extended: true }));

  // Enable CORS
  app.enableCors({
    origin: [
      configService.get('FRONTEND_URL') || 'http://localhost:3000',
      'http://localhost:3000',
    ],
    credentials: true,
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global prefix
  app.setGlobalPrefix('api');

  const port = configService.get('PORT') || 3001;
  await app.listen(port);
  console.log(`🚀 Server running on http://localhost:${port}`);
}
bootstrap();
