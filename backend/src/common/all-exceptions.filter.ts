import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Catches all exceptions and returns the real error message in the response
 * so the frontend can show it (e.g. Connect Amazon failures).
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const isHttpException = exception instanceof HttpException;
    const status = isHttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isHttpException
      ? exception.message
      : exception instanceof Error
        ? exception.message
        : 'Internal server error';

    if (status >= 500) {
      this.logger.error(
        `Unhandled error: ${message}`,
        exception instanceof Error ? exception.stack : undefined,
      );
    }

    let body: { statusCode: number; message: string };
    if (exception instanceof HttpException) {
      const res = exception.getResponse();
      body =
        typeof res === 'object' && res !== null && 'message' in res
          ? { statusCode: status, message: Array.isArray((res as any).message) ? (res as any).message[0] : (res as any).message }
          : { statusCode: status, message: typeof res === 'string' ? res : exception.message };
    } else {
      body = { statusCode: status, message };
    }
    response.status(status).json(body);
  }
}
