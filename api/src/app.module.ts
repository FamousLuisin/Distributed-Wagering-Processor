import { Module } from '@nestjs/common';
import mikroOrmConfig from './database/mikro-orm.config.js';
import { HealthModule } from './modules/health/health.module.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WageringModule } from './modules/wagering/wagering.module.js';

@Module({
  imports: [MikroOrmModule.forRoot(mikroOrmConfig), HealthModule, WageringModule],
})
export class AppModule {}
