// AES-GCM encryption for provider and class keys stored by the operations panel.

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

function modelKeyScope(provider: string, baseUrl: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    new TextEncoder().encode(
      `tapplet-admin-model-key:v1:${JSON.stringify([1, provider, baseUrl])}`,
    ),
  );
}

export async function encryptAdminApiKey(
  value: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: modelKeyScope(provider, baseUrl) },
    await encryptionKey(secret),
    new TextEncoder().encode(value),
  );
  return {
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
    iv: bytesToBase64(iv),
  };
}

export async function decryptAdminApiKey(
  ciphertext: string,
  iv: string,
  secret: string,
  provider: string,
  baseUrl: string,
): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64ToBytes(iv),
      additionalData: modelKeyScope(provider, baseUrl),
    },
    await encryptionKey(secret),
    base64ToBytes(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

// Binds each class key to its class row; admin_model_settings cannot store
// this provider name, so model keys and class keys are never interchangeable.
const CLASS_KEY_SCOPE = "tkslopper-class";

export function encryptClassKey(
  key: string,
  secret: string,
  classCodeHash: string,
): Promise<{ ciphertext: string; iv: string }> {
  return encryptAdminApiKey(key, secret, CLASS_KEY_SCOPE, classCodeHash);
}

export function decryptClassKey(
  ciphertext: string,
  iv: string,
  secret: string,
  classCodeHash: string,
): Promise<string> {
  return decryptAdminApiKey(ciphertext, iv, secret, CLASS_KEY_SCOPE, classCodeHash);
}
