import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@microsoft/microsoft-graph-client';
import { ClientSecretCredential } from '@azure/identity';
import { TokenCredentialAuthenticationProvider } from '@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials';
import { BrevoClient } from '@getbrevo/brevo';

type GraphSendMailBody = {
  message: {
    subject: string;
    body: { contentType: 'HTML' | 'Text'; content: string };
    toRecipients: Array<{ emailAddress: { address: string } }>;
  };
  saveToSentItems?: boolean;
};

@Injectable()
export class EmailService {
  private client: Client | null = null;
  private brevo: BrevoClient | null = null;
  private readonly logger = new Logger(EmailService.name);

  constructor(private readonly config: ConfigService) {}

  private getBrevoApiKey(): string | null {
    const key = this.config.get<string>('BREVO_API_KEY')?.trim();
    return key ? key : null;
  }

  private getBrevoSignupListId(): number | null {
    const raw = this.config.get<string>('BREVO_SIGNUP_LIST_ID')?.trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
  }

  private getSenderEmail(): string | null {
    const sender = this.config.get<string>('SENDER_EMAIL')?.trim();
    return sender && sender.includes('@') ? sender : null;
  }

  private getSenderName(): string {
    return this.config.get<string>('SENDER_NAME')?.trim() || 'SellerBunker';
  }

  private getBrevoClient(): BrevoClient | null {
    if (this.brevo) return this.brevo;
    const apiKey = this.getBrevoApiKey();
    if (!apiKey) return null;
    this.brevo = new BrevoClient({
      apiKey,
      timeoutInSeconds: 30,
      maxRetries: 2,
    });
    return this.brevo;
  }

  private isConfigured(): boolean {
    const tenantId = this.config.get<string>('AZURE_TENANT_ID')?.trim();
    const clientId = this.config.get<string>('AZURE_CLIENT_ID')?.trim();
    const clientSecret = this.config.get<string>('AZURE_CLIENT_SECRET')?.trim();
    return Boolean(tenantId && clientId && clientSecret && this.getSenderEmail());
  }

  private getClient(): Client | null {
    if (this.client) return this.client;
    if (!this.isConfigured()) return null;

    const tenantId = this.config.get<string>('AZURE_TENANT_ID')!.trim();
    const clientId = this.config.get<string>('AZURE_CLIENT_ID')!.trim();
    const clientSecret = this.config.get<string>('AZURE_CLIENT_SECRET')!.trim();

    const credential = new ClientSecretCredential(tenantId, clientId, clientSecret);
    const authProvider = new TokenCredentialAuthenticationProvider(credential, {
      scopes: ['https://graph.microsoft.com/.default'],
    });
    this.client = Client.initWithMiddleware({ authProvider });
    return this.client;
  }

  private async sendGraphMail(payload: GraphSendMailBody): Promise<void> {
    const client = this.getClient();
    if (!client) {
      this.logger.warn('Graph email not configured; skipping sendMail');
      return;
    }
    const sender = this.getSenderEmail();
    if (!sender) {
      this.logger.warn('SENDER_EMAIL missing/invalid; skipping sendMail');
      return;
    }
    await client.api(`/users/${sender}/sendMail`).post(payload);
  }

  private async sendBrevoEmail(params: {
    toEmail: string;
    toName?: string;
    subject: string;
    htmlContent: string;
  }): Promise<void> {
    const brevo = this.getBrevoClient();
    if (!brevo) {
      this.logger.warn('BREVO_API_KEY not configured; skipping Brevo send');
      return;
    }
    const senderEmail = this.getSenderEmail();
    if (!senderEmail) {
      this.logger.warn('SENDER_EMAIL missing/invalid; skipping Brevo send');
      return;
    }

    await brevo.transactionalEmails.sendTransacEmail({
      subject: params.subject,
      htmlContent: params.htmlContent,
      sender: { name: this.getSenderName(), email: senderEmail },
      to: [{ email: params.toEmail, name: params.toName }],
    });
  }

  /** Upsert contact (+ optional signup list). Returns true on success. */
  async addToBrevoList(
    email: string,
    firstName?: string,
    lastName?: string,
  ): Promise<boolean> {
    try {
      const brevo = this.getBrevoClient();
      if (!brevo) {
        this.logger.warn('BREVO_API_KEY not configured; skipping addToBrevoList');
        return false;
      }
      const listId = this.getBrevoSignupListId();
      const normalized = email.trim().toLowerCase();
      await brevo.contacts.createContact({
        email: normalized,
        attributes: {
          FIRSTNAME: (firstName ?? '').trim(),
          LASTNAME: (lastName ?? '').trim(),
        },
        ...(listId ? { listIds: [listId] } : {}),
        updateEnabled: true,
      });
      this.logger.log(
        `Added/updated ${normalized} in Brevo contacts${listId ? ` (listId=${listId})` : ''}`,
      );
      return true;
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'body' in err
            ? JSON.stringify((err as { body?: unknown }).body)
            : String(err);
      this.logger.error(`Failed to add ${email} to Brevo: ${msg}`);
      return false;
    }
  }

  async sendWelcomeEmail(toEmail: string, name?: string) {
    const safeName = (name ?? '').trim();
    const headline = safeName ? `Welcome, ${safeName}!` : 'Welcome!';
    try {
      const html = `
        <h1>${headline}</h1>
        <p>Thanks for signing up to SellerBunker.</p>
        <p>If you have any questions just reply to this email.</p>
        <p>– The SellerBunker Team</p>
      `;

      // Prefer Brevo when configured, otherwise fall back to Graph.
      if (this.getBrevoApiKey()) {
        await this.sendBrevoEmail({
          toEmail,
          toName: safeName || undefined,
          subject: 'Welcome to SellerBunker!',
          htmlContent: html,
        });
      } else {
        await this.sendGraphMail({
          message: {
            subject: 'Welcome to SellerBunker!',
            body: { contentType: 'HTML', content: html },
            toRecipients: [{ emailAddress: { address: toEmail } }],
          },
          saveToSentItems: true,
        });
      }
      this.logger.log(`Welcome email sent to ${toEmail}`);
    } catch (err) {
      this.logger.error(`Failed to send welcome email to ${toEmail}`, err as any);
    }
  }

  async sendBulkEmail(emails: string[], subject: string, htmlContent: string) {
    for (const email of emails) {
      try {
        if (this.getBrevoApiKey()) {
          await this.sendBrevoEmail({
            toEmail: email,
            subject,
            htmlContent,
          });
        } else {
          await this.sendGraphMail({
            message: {
              subject,
              body: { contentType: 'HTML', content: htmlContent },
              toRecipients: [{ emailAddress: { address: email } }],
            },
            saveToSentItems: true,
          });
        }
        this.logger.log(`Bulk email sent to ${email}`);
        await new Promise((res) => setTimeout(res, 250));
      } catch (err) {
        this.logger.error(`Failed to send to ${email}`, err as any);
      }
    }
  }
}

