import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";

const hash = (value) => createHash("sha256").update(value).digest();
const encodeCBOR = isoCBOR.encode;

/** A real, disposable P-256 authenticator for signature/origin/replay regressions. */
export function passkeyAuthenticator() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  const credentialId = randomBytes(32);
  let counter = 0;
  const cose = new Map([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, Buffer.from(jwk.x, "base64url")],
    [-3, Buffer.from(jwk.y, "base64url")],
  ]);
  const data = (rpID, flags, count) => {
    const value = Buffer.alloc(4);
    value.writeUInt32BE(count);
    return Buffer.concat([hash(rpID), Buffer.from([flags]), value]);
  };
  const clientData = (type, challenge, origin) =>
    Buffer.from(
      JSON.stringify({ type, challenge, origin, crossOrigin: false }),
    );
  return {
    id: credentialId.toString("base64url"),
    publicKey: Buffer.from(encodeCBOR(cose)),
    registration(
      options,
      origin,
      { verified = true, rpID = options.rp.id } = {},
    ) {
      const client = clientData("webauthn.create", options.challenge, origin);
      const length = Buffer.alloc(2);
      length.writeUInt16BE(credentialId.length);
      const authData = Buffer.concat([
        data(rpID, verified ? 0x45 : 0x41, 0),
        Buffer.alloc(16),
        length,
        credentialId,
        Buffer.from(encodeCBOR(cose)),
      ]);
      return {
        id: credentialId.toString("base64url"),
        rawId: credentialId.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          attestationObject: Buffer.from(
            encodeCBOR(
              new Map([
                ["fmt", "none"],
                ["attStmt", new Map()],
                ["authData", authData],
              ]),
            ),
          ).toString("base64url"),
          transports: ["internal"],
        },
      };
    },
    authentication(
      options,
      origin,
      { verified = true, rpID = options.rpId, count = ++counter } = {},
    ) {
      const client = clientData("webauthn.get", options.challenge, origin);
      const authData = data(rpID, verified ? 0x05 : 0x01, count);
      return {
        id: credentialId.toString("base64url"),
        rawId: credentialId.toString("base64url"),
        type: "public-key",
        clientExtensionResults: {},
        response: {
          clientDataJSON: client.toString("base64url"),
          authenticatorData: authData.toString("base64url"),
          signature: sign(
            "sha256",
            Buffer.concat([authData, hash(client)]),
            privateKey,
          ).toString("base64url"),
          userHandle: null,
        },
      };
    },
  };
}
