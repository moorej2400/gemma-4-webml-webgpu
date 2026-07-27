export const IOS_CHUNK_MAX_BYTES = 32 * 1024 * 1024;

export function isIOSUserAgent(userAgent) {
  return /iPhone|iPad|iPod/.test(userAgent);
}

export function getLoaderProfile(userAgent = globalThis.navigator?.userAgent ?? "") {
  if (!isIOSUserAgent(userAgent)) return {};
  return {
    concurrency: 1,
    chunkMaxBytes: IOS_CHUNK_MAX_BYTES,
    diskBackedPle: true,
  };
}
