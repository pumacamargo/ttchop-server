import { Client } from 'basic-ftp';
import path from 'path';

export async function uploadFile(localPath, remoteFilename) {
  const client = new Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: process.env.FTP_HOST,
      user: process.env.FTP_USER,
      password: process.env.FTP_PASS,
      secure: false,
    });

    const remotePath = path.join(process.env.FTP_BASE_PATH || '/public_html/uploads/ttchop/collage', remoteFilename);
    await client.ensureDir(path.dirname(remotePath));
    await client.uploadFrom(localPath, remotePath);

    const baseUrl = (process.env.PUBLIC_BASE_URL || 'https://lemonsushi.com/uploads/ttchop/collage').replace(/\/$/, '');
    return `${baseUrl}/${remoteFilename}`;
  } finally {
    client.close();
  }
}
