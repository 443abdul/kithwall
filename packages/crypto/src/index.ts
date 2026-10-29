/**
 * @kithwall/crypto — all client-side cryptography for Kithwall (spec §3).
 *
 * Binary values that are stored or sent are base64url strings without padding;
 * in-memory keys are Uint8Array. Every failure throws KithwallCryptoError with
 * a stable `code`.
 */
export { KithwallCryptoError, type KithwallCryptoErrorCode } from './errors';

export { b64u, randomBytes, newSymmetricKey, canonicalJson } from './encoding';

export {
  type KdfParams,
  type DeriveOptions,
  DEFAULT_KDF,
  MIN_KDF,
  MAX_KDF,
  deriveFromPassword,
  normalizeEmail,
  passwordSalt,
  validateKdfParams,
} from './password';

export {
  type Identity,
  type KeyBundle,
  type Unlocked,
  type PreviousKx,
  MAX_PREVIOUS_KX,
  generateIdentity,
  rotateIdentityBundle,
  createKeyBundle,
  unlockWithPassword,
  unlockWithRecoveryPhrase,
  unlockWithRecoveryKey,
  unlockWithAmk,
  rewrapPassword,
  rotateRecovery,
  recoveryKeyFromPhrase,
  deriveVaultKey,
  deriveCacheKey,
} from './keys';

export {
  PRF_APP_SALT,
  newPrfSalt,
  passkeyWrapAad,
  prfWrapKey,
  wrapAmkWithPrf,
  unwrapAmkWithPrf,
  unlockWithPrf,
} from './passkey';

export { type Sealed, seal, openSealed } from './seal';
export { PQ_PUB_LEN, pqKeysFromKx, signPqPub, verifiedPqPub } from './pq';

export {
  type Audience,
  type EnvelopeHeader,
  type Envelope,
  sealEnvelope,
  openEnvelope,
  deriveSubkey,
  extractContentKey,
  sealWithContentKey,
  openWithContentKey,
  resealEnvelope,
} from './envelope';

export { encryptBlob, decryptBlob } from './blob';

export {
  type EpochRecord, type AdminGrant, type MemberAdd, epochCommit, keyMatchesCommit, signEpochRecord, verifyEpochRecord, signAdminGrant, verifyAdminGrant, signMemberAdd, verifyMemberAdd,
} from './epoch';

export { FILE_CHUNK_SIZE, encryptFile, decryptFile } from './files';

export { splitRecoveryKey, combineRecoveryShares, generateEphemeral, verificationPhrase } from './recovery';

export {
  type KeyChange,
  safetyNumber,
  formatSafetyNumber,
  normalizeSafetyDigits,
  safetyNumbersMatch,
  SAFETY_QR_PREFIX,
  safetyQrPayload,
  parseSafetyQr,
  signChallenge,
  verifyChallenge,
  signKeyChange,
  verifyKeyChange,
} from './safety';

export { signDocument, verifyDocument, documentPublicKey } from './signed';
