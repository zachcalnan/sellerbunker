import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClerkClient, verifyToken } from '@clerk/backend';

interface ClerkTokenPayload {
  sub: string;
  email?: string;
  email_address?: string;
  email_addresses?: { email_address: string }[];
}

@Injectable()
export class ClerkService {
  private readonly secretKey: string;

  constructor(private readonly configService: ConfigService) {
    const secretKey =
      this.configService.get<string>('CLERK_SECRET_KEY') ??
      this.configService.get<string>('CLERK_SECRETKEY');

    if (!secretKey) {
      throw new Error('CLERK_SECRET_KEY is not configured');
    }

    this.secretKey = secretKey;
  }

  async verifyToken(token: string) {
    try {
      // For @clerk/backend v2, verifyToken returns the payload directly.
      const payload = (await verifyToken(token, {
        secretKey: this.secretKey,
      })) as ClerkTokenPayload;

      const clerkUserId = payload.sub;
      const email =
        payload.email ??
        payload.email_address ??
        (Array.isArray(payload.email_addresses)
          ? payload.email_addresses[0]?.email_address
          : undefined);

      if (!clerkUserId) {
        throw new UnauthorizedException('Missing Clerk user id in token');
      }

      return { clerkUserId, email: email ?? '' };
    } catch (err) {
      console.error('Clerk verifyToken error:', err);
      throw new UnauthorizedException('Invalid Clerk token');
    }
  }

  /**
   * Referral code from SignUp unsafeMetadata (set from ?ref= cookie on the client).
   */
  async getReferralCodeFromClerkUser(clerkUserId: string): Promise<string | null> {
    if (!clerkUserId) return null;
    try {
      const client = createClerkClient({ secretKey: this.secretKey });
      const u = await client.users.getUser(clerkUserId);
      const meta = u.unsafeMetadata as Record<string, unknown> | undefined;
      const v = meta?.ref ?? meta?.referralCode;
      if (typeof v === 'string' && v.trim()) return v.trim();
    } catch (err) {
      console.warn('[ClerkService] getUser for referral metadata failed', err);
    }
    return null;
  }
}
