import { readFileSync } from "node:fs";

import {
  PROTOCOL,
  PROVIDER_KINDS,
} from "./contracts.mjs";
import {
  CLAUDE_VERSIONS,
} from "./providers/claude.mjs";
import {
  CODEX_VERSIONS,
} from "./providers/codex.mjs";
import {
  SECRET_STORE_MODES,
  SECRET_STORE_PLATFORMS,
} from "./secrets.mjs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const contractMetadata = JSON.parse(
  readFileSync(new URL("../contracts/v1/version.json", import.meta.url), "utf8"),
);
const protocols = contractMetadata.protocols;

if (
  !Number.isSafeInteger(contractMetadata.revision) ||
  contractMetadata.revision < 0 ||
  !protocols ||
  typeof protocols.manifest !== "string" ||
  typeof protocols.agent !== "string" ||
  typeof protocols.content !== "string" ||
  protocols.agent !== PROTOCOL
)
  throw new Error("Contract metadata is invalid or does not match Core");

/**
 * Return static capabilities for a consumer of the installed Core package.
 * This reads package and contract metadata only; it never contacts a provider,
 * starts a model process, resolves credentials, or returns secret values.
 */
export function coreCapabilities() {
  return Object.freeze({
    schema: "qf.capabilities/v1",
    packageVersion: packageJson.version,
    manifestProtocol: protocols.manifest,
    agentProtocol: protocols.agent,
    contentProtocol: protocols.content,
    contractRevision: contractMetadata.revision,
    providerKinds: Object.freeze([...PROVIDER_KINDS]),
    reviewedCliVersions: Object.freeze({
      claude: Object.freeze([...CLAUDE_VERSIONS]),
      codex: Object.freeze([...CODEX_VERSIONS]),
    }),
    secretStore: Object.freeze({
      platforms: Object.freeze([...SECRET_STORE_PLATFORMS]),
      modes: Object.freeze([...SECRET_STORE_MODES]),
    }),
  });
}
