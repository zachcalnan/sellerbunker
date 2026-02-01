import { Module } from '@nestjs/common';
import { UsersModule } from '../users/users.module';
import { OrgsController } from './orgs.controller';
import { ClerkModule } from '../clerk/clerk.module';

@Module({
  imports: [UsersModule, ClerkModule],
  controllers: [OrgsController],
})
export class OrgsModule {}
