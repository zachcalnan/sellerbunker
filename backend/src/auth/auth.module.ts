import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { UsersModule } from '../users/users.module';
import { EmailModule } from '../email/email.module';
import { JwtStrategy } from './jwt.strategy';

@Module({
  imports: [
    ConfigModule,
    UsersModule,
    EmailModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const expiresIn =
          Number(configService.get<string>('JWT_EXPIRES_IN')) ||
          60 * 60 * 24 * 7; // default 7 days in seconds

        const secret =
          configService.get<string>('JWT_SECRET') ||
          (process.env.NODE_ENV === 'production' ? undefined : 'dev_secret_change_me');
        if (!secret) {
          throw new Error('JWT_SECRET must be set in production');
        }
        return {
          secret,
          signOptions: {
            expiresIn,
          },
        };
      },
    }),
  ],
  providers: [AuthService, JwtStrategy],
  controllers: [AuthController],
  exports: [AuthService],
})
export class AuthModule {}
