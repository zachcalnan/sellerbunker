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

  // Log sync-progress requests so we can confirm the frontend is polling (even if auth fails later)
  app.use((req: any, _res: any, next: () => void) => {
    if (req.method === 'GET' && req.url?.startsWith('/api/amazon/sync-progress')) {
      console.log(`[sync-progress] REQUEST ${req.method} ${req.url}`);
    }
    next();
  });

  // Enable CORS (allow frontend URL + custom domain so payment redirect works on www.sellerbunker.com)
  const frontendUrl = configService.get('FRONTEND_URL') || 'http://localhost:3000';
  const corsOrigins = [
    frontendUrl,
    'http://localhost:3000',
    'https://www.sellerbunker.com',
    'https://sellerbunker.com',
  ];
  const extraOrigins = configService.get('CORS_ORIGINS');
  if (extraOrigins?.length) {
    corsOrigins.push(...extraOrigins.split(',').map((o: string) => o.trim()).filter(Boolean));
  }
  app.enableCors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: [
      'authorization',
      'content-type',
      'x-org-id',
      'x-organization-id',
      'x-marketplace-id',
      'x-repricer-password',
      'x-affiliate-admin-secret',
      // Dev-only header used to test a specific Clerk user locally.
      'x-impersonate-clerk-id',
    ],
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
