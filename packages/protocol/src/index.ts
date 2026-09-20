export {
  encodeBase64Url,
  decodeBase64Url,
  randomBytes,
  randomToken,
  sha256,
  utf8,
} from './base64url.ts';

export {
  PROTOCOL_VERSION,
  PROTOCOL_MIN_SUPPORTED,
  PROTOCOL_MAX_SUPPORTED,
  type ProtocolRange,
  supportedProtocolRange,
  isProtocolCompatible,
  describeProtocolIncompatibility,
} from './version.ts';

export {
  NICKNAME_MAX_LENGTH,
  normalizeNickname,
  isValidNickname,
  PROTOCOL_ERROR_CODES,
  isProtocolErrorCode,
  type PublicKeyJwk,
  type PrivateKeyJwk,
  type ClientHello,
  type ClientMessage,
  type ServerChallenge,
  type ServerWelcome,
  type ServerError,
  type ServerMessage,
  type ProtocolErrorCode,
  type ParseResult,
  serializeMessage,
  parseClientMessage,
  parseServerMessage,
} from './messages.ts';

export {
  DEVICE_ID_PREFIX,
  DEVICE_ID_DOMAIN,
  AUTH_PAYLOAD_DOMAIN,
  type DeviceIdentity,
  canonicalPublicKey,
  deriveDeviceId,
  createDeviceIdentity,
  authPayload,
  signAuthPayload,
  verifyAuthSignature,
  createNonce,
} from './identity.ts';

export {
  type TransportFailureKind,
  type TransportFailureSignal,
  classifyTransportFailure,
  transportFailureSignal,
} from './connectionFailure.ts';

export {
  type ServiceAddressPolicy,
  type ServiceAddressProblem,
  type ServiceAddressResult,
  parseServiceAddress,
  joinPath,
} from './serviceAddress.ts';

export {
  HEALTH_PATH,
  HANDSHAKE_PATH,
  SERVICE_NAME,
  SERVICE_VERSION,
  type HealthPayload,
  parseHealthPayload,
} from './contract.ts';

export {
  CATALOG_SCHEMA,
  CATALOG_PATH,
  CATALOG_RESOURCE_PREFIX,
  CATALOG_CARD_IMAGE_PREFIX,
  type CatalogCardClass,
  type CatalogIdentityRefs,
  type CatalogPrint,
  type CatalogAbility,
  type CatalogAttack,
  type CatalogCardFlags,
  type CatalogImageSource,
  type CatalogCard,
  type CatalogDeckCard,
  type CatalogDeck,
  type CatalogRuleManual,
  type CatalogCounts,
  type CatalogEnvironment,
  type CatalogSupportPolicy,
  type CatalogResource,
  type CatalogSourceFile,
  type CatalogDataRevision,
  type CatalogContent,
  type CatalogRuntimeResource,
  type CatalogRuntimeCardImage,
  type CatalogRuntime,
  type ServiceCatalog,
  canonicalJson,
  computeCatalogVersion,
  parseCatalogContent,
  parseServiceCatalog,
  isResourceAvailable,
  isCardImageAvailable,
} from './catalog.ts';

export {
  type ConnectionFailure,
  type ConnectionFailureKind,
  type ConnectedSession,
  type ConnectionClosedEvent,
  type LiveConnection,
  type ConnectResult,
  type ProbeOutcome,
  type HealthProbe,
  type WebSocketLike,
  type ConnectDependencies,
  type ConnectRequest,
  fetchHealthProbe,
  connectToService,
} from './clientConnection.ts';
