import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { RedisModule } from './redis/redis.module';
import { AmazonModule } from './amazon/amazon.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ClerkModule } from './clerk/clerk.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),
    PrismaModule,
    RedisModule,
    AmazonModule,
    UsersModule,
    AuthModule,
    ClerkModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
