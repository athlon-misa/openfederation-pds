import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { config } from '../config.js';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!config.email.enabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.email.host,
      port: config.email.port,
      secure: config.email.secure,
      auth: config.email.user ? {
        user: config.email.user,
        pass: config.email.password,
      } : undefined,
    });
  }
  return transporter;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    // Dev mode — log to console
    console.log(`[EMAIL] To: ${to}`);
    console.log(`[EMAIL] Subject: ${subject}`);
    console.log(`[EMAIL] Body: ${html.replace(/<[^>]+>/g, '').substring(0, 200)}...`);
    return;
  }

  try {
    await t.sendMail({
      from: config.email.from,
      to,
      subject,
      html,
    });
  } catch (err) {
    console.error('Failed to send email:', err instanceof Error ? err.message : err);
    // Don't throw — email failures shouldn't crash the request
  }
}
