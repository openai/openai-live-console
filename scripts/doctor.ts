import { settingsFromEnv } from '../server/config.ts';
import { createGateway } from '../server/openai.ts';
import { MODEL } from '../server/protocol.ts';
import { publicError } from '../server/errors.ts';

const settings = settingsFromEnv();
if (!settings.apiKey) {
  console.error('OPENAI_API_KEY is missing. Set it in .env or the server environment.');
  process.exitCode = 1;
} else {
  const { client } = createGateway(settings);
  for (const model of [MODEL, settings.backendModel]) {
    try {
      const result = await client.models.retrieve(model);
      console.log(`${model}: model metadata accessible (${result.id}).`);
    } catch (error) {
      const e = publicError(error);
      console.error(`${model}: ${e.message} ${e.action}`);
      process.exitCode = 1;
    }
  }
  console.log(
    'This read-only check does not create a session or prove Live transport, sideband, delegation, audio, or GA availability. Test the browser flow separately.',
  );
}
