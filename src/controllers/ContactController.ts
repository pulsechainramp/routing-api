import { FastifyReply, FastifyRequest } from 'fastify';
import nodemailer from 'nodemailer';
import { Logger } from '../utils/logger';

type ContactPayload = {
  name?: string;
  email?: string;
  subject?: string;
  message?: string;
  source?: string;
  website?: string;
};

const {
  CONTACT_SMTP_HOST,
  CONTACT_SMTP_PORT,
  CONTACT_SMTP_SECURE,
  CONTACT_SMTP_USER,
  CONTACT_SMTP_PASS,
  CONTACT_EMAIL_FROM,
  CONTACT_EMAIL_TO,
} = process.env;

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const escapeHtml = (input: string) =>
  input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const logger = new Logger('ContactController');

const transporter =
  CONTACT_SMTP_HOST &&
  CONTACT_SMTP_USER &&
  CONTACT_SMTP_PASS &&
  CONTACT_EMAIL_TO
    ? nodemailer.createTransport({
        host: CONTACT_SMTP_HOST,
        port: CONTACT_SMTP_PORT ? Number(CONTACT_SMTP_PORT) : 587,
        secure: CONTACT_SMTP_SECURE === 'true',
        auth: {
          user: CONTACT_SMTP_USER,
          pass: CONTACT_SMTP_PASS,
        },
      })
    : null;

if (transporter) {
  transporter
    .verify()
    .then(() => logger.info('Email transporter ready'))
    .catch((error) => logger.error('Email transporter verification failed', { error }));
} else {
  logger.warn('Email transporter not configured. Missing SMTP environment variables.');
}

export class ContactController {
  async submit(
    request: FastifyRequest<{ Body: ContactPayload }>,
    reply: FastifyReply,
  ) {
    if (!transporter) {
      return reply
        .status(503)
        .send({ error: 'Contact form is temporarily unavailable. Please try again later.' });
    }

    const body = request.body;
    if (!body || typeof body !== 'object') {
      return reply.status(400).send({ error: 'Invalid request body.' });
    }

    const { name, email, subject, message, source, website } = body;

    if (website && website.trim().length > 0) {
      return reply.status(400).send({ error: 'Invalid submission.' });
    }

    if (!name || !email || !message) {
      return reply.status(400).send({ error: 'Name, email, and message are required.' });
    }

    if (!emailRegex.test(email)) {
      return reply.status(400).send({ error: 'Please provide a valid email.' });
    }

    if (message.length > 4000) {
      return reply.status(400).send({ error: 'Message is too long.' });
    }

    const cleanSubject = subject?.trim() || 'General Inquiry';
    const contextSource = source?.trim() || 'footer-modal';
    const sanitizedMessage = message.trim();

    const textContent = [
      'New contact form submission from PulseChain Ramp:',
      '',
      `Name: ${name}`,
      `Email: ${email}`,
      `Subject: ${cleanSubject}`,
      `Source: ${contextSource}`,
      '',
      'Message:',
      sanitizedMessage,
    ].join('\n');

    try {
      await transporter.sendMail({
        from: CONTACT_EMAIL_FROM || CONTACT_SMTP_USER,
        to: CONTACT_EMAIL_TO,
        replyTo: email,
        subject: `PulseChain Ramp Contact: ${cleanSubject}`,
        text: textContent,
        html: `<p>New contact form submission from PulseChain Ramp:</p>
               <ul>
                 <li><strong>Name:</strong> ${escapeHtml(name)}</li>
                 <li><strong>Email:</strong> ${escapeHtml(email)}</li>
                 <li><strong>Subject:</strong> ${escapeHtml(cleanSubject)}</li>
                 <li><strong>Source:</strong> ${escapeHtml(contextSource)}</li>
               </ul>
               <p><strong>Message:</strong></p>
               <p>${escapeHtml(sanitizedMessage).replace(/\n/g, '<br/>')}</p>`,
      });

      return reply
        .status(200)
        .send({ message: 'Thanks for reaching out! We will be in touch soon.' });
    } catch (error) {
      logger.error('Failed to send email', { error });
      return reply
        .status(500)
        .send({ error: 'We could not send your message. Please try again later.' });
    }
  }
}
