/*
CLI: Generate TELEGRAM_SESSION (MTProto user session)
Usage:
  TELEGRAM_API_ID=123 TELEGRAM_API_HASH=abc npm run telegram:session
*/
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { createInterface } from 'readline';

function ask(question: string, opts?: { silent?: boolean }): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    if (opts?.silent && (rl as any).stdoutMuted === undefined) {
      // simple masking
      (rl as any).stdoutMuted = true;
      const _write = (rl as any)._writeToOutput.bind(rl as any);
      (rl as any)._writeToOutput = function (str: string) {
        if ((rl as any).stdoutMuted) {
          (rl as any).output.write(str.replace(/.+/g, '*'));
        } else {
          _write(str);
        }
      };
    }
    rl.question(question, (answer) => {
      if (opts?.silent) (rl as any).stdoutMuted = false;
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const apiIdEnv = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiIdEnv || !apiHash) {
    console.error('Set TELEGRAM_API_ID and TELEGRAM_API_HASH environment variables.');
    process.exit(1);
  }
  const apiId = Number(apiIdEnv);
  if (!Number.isFinite(apiId)) {
    console.error('TELEGRAM_API_ID must be a number');
    process.exit(1);
  }

  const session = new StringSession('');
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: async () => await ask('Phone number (with +): '),
    phoneCode: async () => await ask('Login code: '),
    password: async () => {
      const pwd = await ask('2FA password (if enabled, press Enter if none): ', { silent: true });
      return pwd ? pwd : undefined as unknown as string;
    },
    onError: (err) => console.error(err),
  });

  const saved = client.session.save();
  console.log('\nYour TELEGRAM_SESSION (keep it secret):');
  console.log(saved);
  await client.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});


