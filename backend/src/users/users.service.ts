import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { User } from '@prisma/client';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { email },
    });
  }

  async findById(id: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { id },
    });
  }

  async createUser(params: {
    email: string;
    passwordHash: string;
    name?: string;
  }): Promise<User> {
    const { email, passwordHash, name } = params;
    return this.prisma.user.create({
      data: {
        email,
        passwordHash,
        name,
      },
    });
  }

  async findByClerkId(clerkId: string): Promise<User | null> {
    return this.prisma.user.findUnique({
      where: { clerkId: clerkId },
    });
  }

  async createFromClerk(params: {
    clerkId: string;
    email?: string;
  }): Promise<User> {
    const { clerkId, email } = params;
    // Fallback email if Clerk token doesn't include one yet.
    // This keeps the schema happy (email is required & unique) while
    // still keying identity off clerkId.
    const emailToUse = email && email.length > 0
      ? email
      : `${clerkId}@placeholder.local`;

    return this.prisma.user.create({
      data: {
        clerkId: clerkId,
        email: emailToUse,
        passwordHash: '',
      },
    });
  }
}

