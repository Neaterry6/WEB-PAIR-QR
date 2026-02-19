import { Storage } from 'megajs';

/** MEGA Auth config */
const auth = {
  email: 'osayamonharrypotter@gmail.com',
  password: 'Osayamon@1',
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246'
};

/**
 * Uploads a file to MEGA
 * @param {Buffer|string} data - File content
 * @param {string} name - File name
 * @returns {Promise<string>} - Public MEGA link
 */
export const upload = async (data, name) => {
  if (typeof data === 'string') data = Buffer.from(data);

  const storage = new Storage(auth);
  await storage.ready;

  try {
    const file = await storage.upload({ name, size: data.length }, data).complete;
    const url = await file.link();
    return url;
  } finally {
    storage.close();
  }
};