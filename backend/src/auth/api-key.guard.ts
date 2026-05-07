import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<any>();
    const expected = (this.config.get<string>('SELLERBUNKER_API_KEY') ?? '').trim();
    if (!expected) {
      throw new UnauthorizedException('API key auth not configured');
    }
    const key =
      (req.headers['x-api-key'] as string | undefined)?.trim() ??
      (req.headers['x-sellerbunker-api-key'] as string | undefined)?.trim() ??
      '';
    if (!key) {
      throw new UnauthorizedException('Missing x-api-key header');
    }
    if (key !== expected) {
      throw new UnauthorizedException('Invalid API key');
    }
    return true;
  }
}

