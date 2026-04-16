import { join } from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AmazonModule } from './amazon/amazon.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ClerkModule } from './clerk/clerk.module';
import { OrgsModule } from './orgs/orgs.module';
import { SubscriptionModule } from './subscription/subscription.module';
import { StripeModule } from './stripe/stripe.module';
import { MarketplaceModule } from './marketplace/marketplace.module';
import { AffiliateModule } from './affiliate/affiliate.module';
import { RepricerModule } from './repricer/repricer.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // Load .env from backend dir when run from backend/ or from repo root
      envFilePath: [
        join(process.cwd(), '.env'),
        join(process.cwd(), 'backend', '.env'),
      ],
    }),
    BullModule.forRootAsync({
      useFactory: (config: ConfigService) => {
        const redisUrl =
          config.get<string>('REDIS_URL') ?? 'redis://localhost:6379';
        return {
          connection: {
            url: redisUrl,
          },
        };
      },
      inject: [ConfigService],
    }),
    PrismaModule,
    RedisModule,
    AmazonModule,
    UsersModule,
    OrgsModule,
    AuthModule,
    ClerkModule,
    SubscriptionModule,
    StripeModule,
    MarketplaceModule,
    AffiliateModule,
    RepricerModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
