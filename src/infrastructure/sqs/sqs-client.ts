// With an explicit endpoint the client talks to a local emulator, which accepts the dummy
// credentials below. Without one it uses the standard AWS credential chain. The endpoint
// always wins over the host inside a queue URL, so the same URLs work from the host and
// from inside the Compose network.
import { SQSClient } from '@aws-sdk/client-sqs';
import type { SqsConfig } from '../../config/config';

const EMULATOR_CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };

export function createSqsClient(config: SqsConfig): SQSClient {
  if (config.endpoint === undefined) {
    return new SQSClient({ region: config.region });
  }
  return new SQSClient({
    region: config.region,
    endpoint: config.endpoint,
    credentials: EMULATOR_CREDENTIALS,
    useQueueUrlAsEndpoint: false,
  });
}
