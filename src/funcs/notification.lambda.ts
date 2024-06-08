import { promisify } from 'util';
import { gunzip } from 'zlib';
import { CloudWatchLogsEvent, Context } from 'aws-lambda';

const gunzipAsync = promisify(gunzip);

export const handler = async (event: CloudWatchLogsEvent, context: Context): Promise<void> => {
  console.log({ event: event });
  console.log({ context: context });

  const payload = Buffer.from(event.awslogs.data, 'base64');

  try {
    const result = await gunzipAsync(payload);
    const logData = JSON.parse(result.toString('utf8'));
    console.log({ DecodedLog: logData });
    // ここでlogDataを処理する
    return logData;
  } catch (error) {
    console.error(null, error);
    throw error;
  }
};