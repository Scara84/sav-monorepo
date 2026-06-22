import { describe, expect, it } from 'vitest'
import { createTransport } from 'nodemailer'

describe('Nodemailer 9 runtime compatibility', () => {
  it('renders the SMTP wrapper mail shape and attachment without network access', async () => {
    const transport = createTransport({
      streamTransport: true,
      buffer: true,
      newline: 'unix',
    })

    const info = await transport.sendMail({
      from: 'sav@fruitstock.eu',
      to: 'member@example.com',
      replyTo: 'support@fruitstock.eu',
      subject: 'Validation SAV',
      html: '<p>Votre demande est validée.</p>',
      text: 'Votre demande est validée.',
      attachments: [{ filename: 'bon-sav.pdf', content: Buffer.from('pdf-test') }],
    })

    const message = info.message.toString()
    expect(info.messageId).toBeTruthy()
    expect(message).toContain('Subject: Validation SAV')
    expect(message).toContain('Reply-To: support@fruitstock.eu')
    expect(message).toContain('filename=bon-sav.pdf')
  })
})
