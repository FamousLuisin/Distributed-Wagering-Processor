import { Module } from '@nestjs/common';
import { WalletApplicationService } from './application/wallet-application.service.js';
import { WalletsController } from './presentation/wallets.controller.js';

@Module({
  controllers: [WalletsController],
  providers: [WalletApplicationService],
  exports: [WalletApplicationService],
})
export class WalletsModule {}
