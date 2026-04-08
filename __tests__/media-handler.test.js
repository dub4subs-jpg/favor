const MediaHandler = require('../core/media-handler');

const makeMsg = (message, jid = '1234@s.whatsapp.net') => ({
  key: { remoteJid: jid },
  message,
});

const createHandler = () =>
  new MediaHandler({
    config: { api: {} },
    videoProcessor: null,
    PLATFORM: 'whatsapp',
    botDir: __dirname,
  });

describe('MediaHandler constructor', () => {
  test('accepts required deps and sets properties', () => {
    const handler = createHandler();
    expect(handler.config).toEqual({ api: {} });
    expect(handler.videoProcessor).toBeNull();
    expect(handler.PLATFORM).toBe('whatsapp');
    expect(handler.botDir).toBe(__dirname);
  });

  test('initializes dedup state', () => {
    const handler = createHandler();
    expect(handler._recentMessages).toBeInstanceOf(Map);
    expect(handler._recentMessages.size).toBe(0);
    expect(handler.DEDUP_WINDOW_MS).toBe(5000);
  });

  test('initializes lastReceivedImage as null', () => {
    const handler = createHandler();
    expect(handler.lastReceivedImage).toBeNull();
  });
});

describe('extractText', () => {
  let handler;
  beforeAll(() => { handler = createHandler(); });

  test('returns conversation text', () => {
    const msg = makeMsg({ conversation: 'hello world' });
    expect(handler.extractText(msg)).toBe('hello world');
  });

  test('returns extendedTextMessage text', () => {
    const msg = makeMsg({ extendedTextMessage: { text: 'quoted reply' } });
    expect(handler.extractText(msg)).toBe('quoted reply');
  });

  test('returns imageMessage caption', () => {
    const msg = makeMsg({ imageMessage: { caption: 'photo caption', mimetype: 'image/jpeg' } });
    expect(handler.extractText(msg)).toBe('photo caption');
  });

  test('returns videoMessage caption', () => {
    const msg = makeMsg({ videoMessage: { caption: 'video caption', mimetype: 'video/mp4' } });
    expect(handler.extractText(msg)).toBe('video caption');
  });

  test('returns documentMessage caption', () => {
    const msg = makeMsg({ documentMessage: { caption: 'doc caption', mimetype: 'application/pdf' } });
    expect(handler.extractText(msg)).toBe('doc caption');
  });

  test('returns empty string for null message', () => {
    const msg = makeMsg(null);
    expect(handler.extractText(msg)).toBe('');
  });

  test('returns empty string for undefined message', () => {
    expect(handler.extractText({ key: { remoteJid: '1234@s.whatsapp.net' } })).toBe('');
  });

  test('returns empty string for missing fields', () => {
    const msg = makeMsg({});
    expect(handler.extractText(msg)).toBe('');
  });

  test('returns empty string for imageMessage without caption', () => {
    const msg = makeMsg({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(handler.extractText(msg)).toBe('');
  });

  test('prioritizes conversation over extendedTextMessage', () => {
    const msg = makeMsg({ conversation: 'first', extendedTextMessage: { text: 'second' } });
    expect(handler.extractText(msg)).toBe('first');
  });
});

describe('getMessageType', () => {
  let handler;
  beforeAll(() => { handler = createHandler(); });

  test('returns image for imageMessage', () => {
    const msg = makeMsg({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(handler.getMessageType(msg)).toBe('image');
  });

  test('returns voice for audioMessage', () => {
    const msg = makeMsg({ audioMessage: { mimetype: 'audio/ogg' } });
    expect(handler.getMessageType(msg)).toBe('voice');
  });

  test('returns voice for pttMessage (push-to-talk)', () => {
    const msg = makeMsg({ pttMessage: { mimetype: 'audio/ogg' } });
    expect(handler.getMessageType(msg)).toBe('voice');
  });

  test('returns video for videoMessage', () => {
    const msg = makeMsg({ videoMessage: { mimetype: 'video/mp4' } });
    expect(handler.getMessageType(msg)).toBe('video');
  });

  test('returns document for documentMessage', () => {
    const msg = makeMsg({ documentMessage: { mimetype: 'application/pdf' } });
    expect(handler.getMessageType(msg)).toBe('document');
  });

  test('returns sticker for stickerMessage', () => {
    const msg = makeMsg({ stickerMessage: { mimetype: 'image/webp' } });
    expect(handler.getMessageType(msg)).toBe('sticker');
  });

  test('returns text for conversation message', () => {
    const msg = makeMsg({ conversation: 'hello' });
    expect(handler.getMessageType(msg)).toBe('text');
  });

  test('returns text for extendedTextMessage', () => {
    const msg = makeMsg({ extendedTextMessage: { text: 'quoted' } });
    expect(handler.getMessageType(msg)).toBe('text');
  });

  test('returns unknown for null message', () => {
    const msg = makeMsg(null);
    expect(handler.getMessageType(msg)).toBe('unknown');
  });

  test('returns unknown for undefined message', () => {
    expect(handler.getMessageType({ key: { remoteJid: '1234@s.whatsapp.net' } })).toBe('unknown');
  });
});

describe('isDuplicateMessage', () => {
  test('first message is not a duplicate', () => {
    const handler = createHandler();
    const msg = makeMsg({ conversation: 'hello' });
    expect(handler.isDuplicateMessage(msg)).toBe(false);
  });

  test('same message within window is a duplicate', () => {
    const handler = createHandler();
    const msg = makeMsg({ conversation: 'hello' });
    handler.isDuplicateMessage(msg);
    expect(handler.isDuplicateMessage(msg)).toBe(true);
  });

  test('different messages from same sender are not duplicates', () => {
    const handler = createHandler();
    const msg1 = makeMsg({ conversation: 'hello' });
    const msg2 = makeMsg({ conversation: 'goodbye' });
    handler.isDuplicateMessage(msg1);
    expect(handler.isDuplicateMessage(msg2)).toBe(false);
  });

  test('same text from different senders are not duplicates', () => {
    const handler = createHandler();
    const msg1 = makeMsg({ conversation: 'hello' }, '1111@s.whatsapp.net');
    const msg2 = makeMsg({ conversation: 'hello' }, '2222@s.whatsapp.net');
    handler.isDuplicateMessage(msg1);
    expect(handler.isDuplicateMessage(msg2)).toBe(false);
  });

  test('same message after window expires is not a duplicate', () => {
    const handler = createHandler();
    const msg = makeMsg({ conversation: 'hello' });
    handler.isDuplicateMessage(msg);

    // Manually expire the entry by backdating it
    for (const [key] of handler._recentMessages) {
      handler._recentMessages.set(key, Date.now() - handler.DEDUP_WINDOW_MS - 1);
    }

    expect(handler.isDuplicateMessage(msg)).toBe(false);
  });

  test('dedup uses jid + text as key components', () => {
    const handler = createHandler();
    const msg1 = makeMsg({ conversation: 'same text' }, 'aaa@s.whatsapp.net');
    handler.isDuplicateMessage(msg1);
    // Same text, different jid should not be duplicate
    const msg2 = makeMsg({ conversation: 'same text' }, 'bbb@s.whatsapp.net');
    expect(handler.isDuplicateMessage(msg2)).toBe(false);
    // Same jid and text should be duplicate
    expect(handler.isDuplicateMessage(msg1)).toBe(true);
  });

  test('message with no text body deduplicates correctly', () => {
    const handler = createHandler();
    const msg = makeMsg({ imageMessage: { mimetype: 'image/jpeg' } });
    expect(handler.isDuplicateMessage(msg)).toBe(false);
    expect(handler.isDuplicateMessage(msg)).toBe(true);
  });
});
