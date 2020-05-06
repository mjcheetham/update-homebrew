import { createHash } from 'crypto';
import * as http from 'http';
import * as https from 'https';

async function processChunksAsync(
  url: string,
  process: (data: Buffer) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let get;
    if (url.toLowerCase().startsWith('https://')) {
      get = https.get;
    } else if (url.toLowerCase().startsWith('http://')) {
      get = http.get;
    } else {
      throw new Error(`unknown scheme type in URL '${url}'`);
    }

    get(url, response => {
      if (
        response.statusCode &&
        (response.statusCode < 200 || response.statusCode > 299)
      ) {
        throw new Error(`download failed ${response.statusCode}`);
      }
      response.on('data', process);
      response.on('end', resolve);
    }).on('error', reject);
  });
}

export async function computeSha256Async(url: string): Promise<string> {
  const sha256 = createHash('sha256');
  await processChunksAsync(url, data => sha256.update(data));
  return sha256.digest('base64');
}
