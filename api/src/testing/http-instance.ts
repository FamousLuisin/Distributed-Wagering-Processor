import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';

const app = await NestFactory.create(AppModule, { logger: false });
app.enableShutdownHooks();
await app.listen(Number(process.env.PORT ?? 0), '127.0.0.1');

const address = app.getHttpServer().address();
if (!address || typeof address === 'string') {
  throw new Error('Could not determine the HTTP test instance address');
}

process.stdout.write(`INSTANCE_READY http://127.0.0.1:${address.port}\n`);
