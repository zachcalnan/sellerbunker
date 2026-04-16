import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class RepricerPasswordGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<any>();
    // Default password for testing unless overridden via env.
    const configured =
      (this.config.get<string>('REPRICER_PASSWORD') ?? '').trim() || 'repricer';
    const provided = String(req.headers['x-repricer-password'] ?? '').trim();
    if (!provided || provided !== configured) {
      throw new ForbiddenException('Invalid repricer password');
    }
    return true;
  }
}

