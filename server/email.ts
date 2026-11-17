import nodemailer from 'nodemailer';

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
    tls: { rejectUnauthorized: false }
  });
  return transporter;
}

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const t = getTransporter();
  if (!t) {
    console.warn('[EMAIL] SMTP not configured; skipping email to', to);
    return;
  }
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || 'info@bidbes.com';
  try {
    await t.sendMail({ from, to, subject, html });
    console.log('[EMAIL] sent to', to, subject);
  } catch (err) {
    console.error('[EMAIL] failed to send to', to, err);
  }
}

export function welcomeEmail(name: string): { subject: string; html: string } {
  const safe = String(name || 'there').replace(/[<>&]/g, '');
  return {
    subject: 'Welcome to TrendLogic',
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0f1a;color:#e2e8f0;border-radius:16px">
      <h2 style="margin:0 0 12px;color:#f43f5e">Welcome to TrendLogic</h2>
      <p>Hi ${safe},</p>
      <p>Your account has been created successfully. You can now sign in and start producing trend videos.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:24px">If you did not create this account, please ignore this email.</p>
    </div>`
  };
}

export function purchaseReceivedEmail(name: string, gb: number, months: number, network: string): { subject: string; html: string } {
  return {
    subject: 'Subscription purchase request received',
    html: `<p>Hi ${name || 'there'},</p><p>We received your storage subscription request: ${gb} GB for ${months} month(s) via ${network}.</p><p>It is pending admin review. You will be notified once approved.</p>`
  };
}

export function purchaseApprovedEmail(name: string, gb: number, months: number, expiresAt: string | null): { subject: string; html: string } {
  return {
    subject: 'Subscription approved',
    html: `<p>Hi ${name || 'there'},</p><p>Your storage subscription has been approved: ${gb} GB for ${months} month(s).</p>${expiresAt ? `<p>Active until: ${expiresAt}</p>` : ''}`
  };
}

export function purchaseRejectedEmail(name: string, note?: string): { subject: string; html: string } {
  return {
    subject: 'Subscription request rejected',
    html: `<p>Hi ${name || 'there'},</p><p>Your storage subscription request was rejected.</p>${note ? `<p>Note: ${note}</p>` : ''}`
  };
}

export function verificationCodeEmail(code: string): { subject: string; html: string } {
  const safe = String(code).replace(/[^0-9]/g, '');
  return {
    subject: 'Your TrendLogic verification code',
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0f1a;color:#e2e8f0;border-radius:16px;text-align:center">
      <h2 style="margin:0 0 12px;color:#f43f5e">Verify your email</h2>
      <p>Your verification code is</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#fff;margin:16px 0">${safe}</div>
      <p style="color:#94a3b8;font-size:13px">It expires in 10 minutes. If you did not request this, ignore this email.</p>
    </div>`
  };
}

export function passwordResetCodeEmail(code: string): { subject: string; html: string } {
  const safe = String(code).replace(/[^0-9]/g, '');
  return {
    subject: 'Reset your TrendLogic password',
    html: `<div style="font-family:system-ui,sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#0b0f1a;color:#e2e8f0;border-radius:16px;text-align:center">
      <h2 style="margin:0 0 12px;color:#f43f5e">Reset your password</h2>
      <p>Your password reset code is</p>
      <div style="font-size:32px;font-weight:800;letter-spacing:8px;color:#fff;margin:16px 0">${safe}</div>
      <p style="color:#94a3b8;font-size:13px">It expires in 10 minutes. If you did not request this, ignore this email.</p>
    </div>`
  };
}

export function subscriptionExpiredEmail(name: string): { subject: string; html: string } {
  return {
    subject: 'Subscription expired',
    html: `<p>Hi ${name || 'there'},</p><p>Your storage subscription has expired. Please renew to continue uploading.</p>`
  };
}