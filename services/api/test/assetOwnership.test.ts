import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { CloudflareAssetStore } from '../src/assets';
import { migratedDatabase } from './sqliteD1';

const ASSET_ROW = {
  id: 'asset-0123456789abcdef0123456789abcdef',
  owner_hash: 'owner-a',
  object_key: 'assets/owner-a/example.png',
  content_type: 'image/png',
  byte_length: 128,
  width: 1,
  height: 1,
  sha256: 'a'.repeat(64),
  alternative_text: 'A diagram',
  decorative: 0,
  created_at: '2026-01-01T00:00:00.000Z',
};

const ONE_PIXEL_CANONICAL_JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
  0x00, 0xff, 0xd9,
]);

function fakeDatabase(): D1Database {
  return {
    prepare() {
      const statement = {
        bind() { return statement; },
        first() { return Promise.resolve(ASSET_ROW); },
        run() { return Promise.resolve({ meta: { changes: 1 } }); },
        all() { return Promise.resolve({ results: [ASSET_ROW] }); },
      };
      return statement;
    },
  } as unknown as D1Database;
}

function insertAsset(sqlite: DatabaseSync, id: string, ownerHash: string, createdAt: string) {
  sqlite
    .prepare('INSERT INTO assets VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, ownerHash, `assets/${id}.jpg`, 'image/jpeg', 1, 1, 1, 'a'.repeat(64), null, 1, createdAt);
}

function insertRevisionReference(sqlite: DatabaseSync, ownerHash: string, assetId: string) {
  const artifactId = `${ownerHash}-artifact`,
    revisionId = `${ownerHash}-revision`,
    createdAt = '2026-01-01T00:00:00.000Z';
  sqlite
    .prepare('INSERT INTO artifacts(id,owner_hash,title,creation_brief,head_revision_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(artifactId, ownerHash, 'Remix', '{}', revisionId, createdAt, createdAt);
  sqlite
    .prepare('INSERT INTO revisions(id,artifact_id,source_hash,source_bytes,kind,model_version,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(revisionId, artifactId, 'hash', 1, 'remix', 'fixture', 'v1', createdAt);
  sqlite.prepare('INSERT INTO revision_assets VALUES(?,?)').run(revisionId, assetId);
}

describe('asset reference ownership', () => {
  it('loads asset metadata without fetching the R2 object body', async () => {
    const bucketGet = vi.fn();
    const store = new CloudflareAssetStore(
      fakeDatabase(),
      { get: bucketGet } as unknown as R2Bucket,
    );

    await expect(store.getRecord(ASSET_ROW.id)).resolves.toMatchObject({
      id: ASSET_ROW.id,
      ownerHash: ASSET_ROW.owner_hash,
      objectKey: ASSET_ROW.object_key,
    });
    expect(bucketGet).not.toHaveBeenCalled();
  });

  it('deletes an unreferenced owned asset and reports referenced or unknown ones', async () => {
    const { database, sqlite } = migratedDatabase();
    try {
      insertAsset(sqlite, 'asset-free', 'owner-a', ASSET_ROW.created_at);
      insertAsset(sqlite, 'asset-remixed', 'owner-a', ASSET_ROW.created_at);
      // Another owner's revision still links the asset, e.g. after a remix.
      insertRevisionReference(sqlite, 'owner-b', 'asset-remixed');
      const bucketDelete = vi.fn().mockResolvedValue(undefined);
      const store = new CloudflareAssetStore(
        database,
        { delete: bucketDelete } as unknown as R2Bucket,
      );

      await expect(store.deleteOwned('asset-remixed', 'owner-a')).resolves.toBe('in-use');
      await expect(store.deleteOwned('asset-free', 'owner-b')).resolves.toBe('missing');
      await expect(store.deleteOwned('asset-unknown', 'owner-a')).resolves.toBe('missing');
      expect(bucketDelete).not.toHaveBeenCalled();
      await expect(store.deleteOwned('asset-free', 'owner-a')).resolves.toBe('deleted');
      expect(bucketDelete).toHaveBeenCalledExactlyOnceWith('assets/asset-free.jpg');
      expect(sqlite.prepare('SELECT id FROM assets').all()).toEqual([{ id: 'asset-remixed' }]);
    } finally {
      sqlite.close();
    }
  });

  it('cleans up only unreferenced assets created before the cutoff', async () => {
    const { database, sqlite } = migratedDatabase();
    try {
      insertAsset(sqlite, 'asset-old-orphan', 'owner-a', '2026-01-01T00:00:00.000Z');
      insertAsset(sqlite, 'asset-old-linked', 'owner-a', '2026-01-01T00:00:00.000Z');
      insertAsset(sqlite, 'asset-new-orphan', 'owner-a', '2026-02-15T00:00:00.000Z');
      insertRevisionReference(sqlite, 'owner-b', 'asset-old-linked');
      const bucketDelete = vi.fn().mockResolvedValue(undefined);
      const store = new CloudflareAssetStore(
        database,
        { delete: bucketDelete } as unknown as R2Bucket,
      );

      await expect(store.cleanupOrphans(
        '2026-02-01T00:00:00.000Z',
        '2026-03-01T00:00:00.000Z',
      )).resolves.toBe(1);
      expect(bucketDelete).toHaveBeenCalledExactlyOnceWith('assets/asset-old-orphan.jpg');
      expect(sqlite.prepare('SELECT id FROM assets ORDER BY id').all()).toEqual([
        { id: 'asset-new-orphan' },
        { id: 'asset-old-linked' },
      ]);
    } finally {
      sqlite.close();
    }
  });

  it('persists only canonical JPEG bytes and metadata after normalizing an upload', async () => {
    const source = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const payload = new TextEncoder().encode('private pupil note');
    const privateChunk = pngChunk('prIV', payload);
    const upload = new Uint8Array(source.length + privateChunk.length);
    upload.set(source.slice(0, 33));
    upload.set(privateChunk, 33);
    upload.set(source.slice(33), 33 + privateChunk.length);

    const bucketPut = vi.fn().mockResolvedValue(undefined);
    const normalize = vi.fn().mockResolvedValue(ONE_PIXEL_CANONICAL_JPEG);
    const imageInspect = vi.fn().mockResolvedValue({
      status: 'flagged',
      reason: 'A possible pupil face is visible.',
    });
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          first() {
            return Promise.resolve(
              sql.includes('COUNT(*) AS asset_count')
                ? { asset_count: 0, total_bytes: 0 }
                : null,
            );
          },
          run() { return Promise.resolve({ meta: { changes: 1 } }); },
        };
        return statement;
      },
    } as unknown as D1Database;
    const store = new CloudflareAssetStore(
      database,
      { put: bucketPut, delete: vi.fn() } as unknown as R2Bucket,
      { normalize },
      { inspect: imageInspect },
    );
    const incomingHash = createHash('sha256').update(upload).digest('hex');

    const record = await store.put(
      new Request('https://api.example.test/v1/assets', {
        method: 'POST',
        headers: {
          'content-type': 'image/png',
          'x-image-width': '1',
          'x-image-height': '1',
          'x-image-decorative': 'true',
          'x-image-sha256': incomingHash,
        },
        body: upload,
      }),
      {
        ownerHash: 'owner-a',
        networkHash: 'network-a',
        now: '2026-07-18T00:00:00.000Z',
        maximumNetworkCount: 100,
        maximumNetworkBytes: 10_000_000,
      },
    );

    const storedBytes = bucketPut.mock.calls[0]?.[1] as Uint8Array;
    const storedOptions = bucketPut.mock.calls[0]?.[2] as {
      customMetadata: { sha256: string };
    };
    const canonicalHash = createHash('sha256').update(ONE_PIXEL_CANONICAL_JPEG).digest('hex');
    expect(normalize).toHaveBeenCalledWith(upload, 'image/png');
    expect(storedBytes).toEqual(ONE_PIXEL_CANONICAL_JPEG);
    expect(storedBytes).not.toEqual(upload);
    expect(new TextDecoder().decode(storedBytes)).not.toContain('private pupil note');
    expect(imageInspect).toHaveBeenCalledWith(ONE_PIXEL_CANONICAL_JPEG, 'image/jpeg');
    expect(record.contentType).toBe('image/jpeg');
    expect(record.byteLength).toBe(ONE_PIXEL_CANONICAL_JPEG.byteLength);
    expect(record.byteLength).not.toBe(upload.byteLength);
    expect(record.sha256).toBe(canonicalHash);
    expect(storedOptions.customMetadata.sha256).toBe(canonicalHash);
    expect(record.sha256).not.toBe(incomingHash);
    expect(record.warnings).toEqual([
      expect.objectContaining({
        source: 'image',
        code: 'AI_IMAGE_REVIEW_FLAGGED',
        message: expect.stringContaining('possible person'),
      }),
    ]);
  });

  it('stores valid images with an advisory when image review is unavailable', async () => {
    const reviewers = [
      undefined,
      { inspect: vi.fn().mockResolvedValue({ status: 'unavailable' }) },
      { inspect: vi.fn().mockRejectedValue(new Error('review offline')) },
    ];

    for (const reviewer of reviewers) {
      const bucketPut = vi.fn().mockResolvedValue(undefined);
      const store = new CloudflareAssetStore(
        fakeDatabase(),
        { put: bucketPut, delete: vi.fn() } as unknown as R2Bucket,
        { normalize: vi.fn().mockResolvedValue(ONE_PIXEL_CANONICAL_JPEG) },
        reviewer,
      );
      const upload = Uint8Array.from([1, 2, 3]);
      const record = await store.put(
        new Request('https://api.example.test/v1/assets', {
          method: 'POST',
          headers: {
            'content-type': 'image/png',
            'x-image-width': '1',
            'x-image-height': '1',
            'x-image-decorative': 'true',
          },
          body: upload,
        }),
        {
          ownerHash: 'owner-a',
          networkHash: 'network-a',
          now: '2026-07-18T00:00:00.000Z',
          maximumNetworkCount: 100,
          maximumNetworkBytes: 10_000_000,
        },
      );

      expect(record.warnings).toEqual([
        expect.objectContaining({
          source: 'image',
          code: 'AI_IMAGE_REVIEW_UNAVAILABLE',
        }),
      ]);
      expect(bucketPut).toHaveBeenCalledOnce();
    }
  });

  it('fails closed when the injected normalizer returns malformed output', async () => {
    const bucketPut = vi.fn();
    const imageInspect = vi.fn();
    const store = new CloudflareAssetStore(
      fakeDatabase(),
      { put: bucketPut } as unknown as R2Bucket,
      { normalize: vi.fn().mockResolvedValue(new TextEncoder().encode('not a JPEG')) },
      { inspect: imageInspect },
    );

    const request = new Request('https://api.example.test/v1/assets', {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-image-width': '1',
        'x-image-height': '1',
        'x-image-decorative': 'true',
      },
      body: Uint8Array.from([1, 2, 3]),
    });

    await expect(store.put(request, {
      ownerHash: 'owner-a',
      networkHash: 'network-a',
      now: '2026-07-18T00:00:00.000Z',
      maximumNetworkCount: 100,
      maximumNetworkBytes: 10_000_000,
    })).rejects.toMatchObject({ code: 'INVALID_IMAGE_BYTES' });
    expect(imageInspect).not.toHaveBeenCalled();
    expect(bucketPut).not.toHaveBeenCalled();
  });

  it('reserves owner and network quotas before image canonicalisation', async () => {
    const events: string[] = [];
    const database = {
      prepare(sql: string) {
        const statement = {
          bind() { return statement; },
          run() {
            if (sql.includes('INSERT INTO asset_usage')) events.push('quota');
            return Promise.resolve({ meta: { changes: 1 } });
          },
        };
        return statement;
      },
    } as unknown as D1Database;
    const normalize = vi.fn().mockImplementation(async () => {
      events.push('normalise');
      return ONE_PIXEL_CANONICAL_JPEG;
    });
    const store = new CloudflareAssetStore(
      database,
      { put: vi.fn() } as unknown as R2Bucket,
      { normalize },
      { inspect: vi.fn() },
    );

    const upload = Uint8Array.from([1, 2, 3]);
    const request = new Request('https://api.example.test/v1/assets', {
      method: 'POST',
      headers: {
        'content-type': 'image/png',
        'x-image-width': '2',
        'x-image-height': '1',
        'x-image-decorative': 'true',
      },
      body: upload,
    });

    await expect(store.put(request, {
      ownerHash: 'owner-a',
      networkHash: 'network-a',
      now: '2026-07-18T00:00:00.000Z',
      maximumNetworkCount: 100,
      maximumNetworkBytes: 10_000_000,
    })).rejects.toMatchObject({ code: 'IMAGE_DIMENSIONS_MISMATCH' });
    expect(events).toEqual(['quota', 'quota', 'normalise']);
  });
});

function pngChunk(type: string, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(12 + payload.length);
  const typeBytes = new TextEncoder().encode(type);
  new DataView(result.buffer).setUint32(0, payload.length, false);
  result.set(typeBytes, 4);
  result.set(payload, 8);
  const checksumInput = new Uint8Array(typeBytes.length + payload.length);
  checksumInput.set(typeBytes);
  checksumInput.set(payload, typeBytes.length);
  new DataView(result.buffer).setUint32(8 + payload.length, crc32(checksumInput), false);
  return result;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffffffff;
  for (const byte of bytes) {
    checksum ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      checksum = (checksum >>> 1) ^ (checksum & 1 ? 0xedb88320 : 0);
    }
  }
  return (checksum ^ 0xffffffff) >>> 0;
}
