import { Module } from '@nestjs/common';
import mikroOrmConfig from './database/mikro-orm.config.js';
import { HealthModule } from './modules/health/health.module.js';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { WageringModule } from './modules/wagering/wagering.module.js';
import { MessagingModule } from './modules/messaging/messaging.module.js';
import { WalletsModule } from './modules/wallets/wallets.module.js';
import { ObservabilityModule } from './shared/observability/observability.module.js';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    HealthModule,
    WageringModule,
    WalletsModule,
    MessagingModule,
  ],
})
export class AppModule {}
