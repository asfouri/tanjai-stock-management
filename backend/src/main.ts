import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const allowedOrigins = getAllowedOrigins();

  app.use(compression());
  app.enableCors({
    origin: createCorsOriginHandler(allowedOrigins),
    credentials: true,
  });
  await app.listen(process.env.PORT ?? 3005);
}
void bootstrap();

type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;

function getAllowedOrigins() {
  return new Set([
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
    'http://127.0.0.1:3002',
    ...parseOrigins(process.env.FRONTEND_URLS ?? process.env.FRONTEND_URL),
  ]);
}

function createCorsOriginHandler(allowedOrigins: Set<string>) {
  return (origin: string | undefined, callback: CorsOriginCallback) => {
    if (!origin || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }

    callback(new Error(`Origin ${origin} is not allowed by CORS.`), false);
  };
}

function parseOrigins(value: string | undefined) {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
