import Foundation
import CryptoKit
import Darwin
import LocalAuthentication
import Security

enum ApprovalError: Error, CustomStringConvertible {
    case failure(String)

    var description: String {
        switch self {
        case .failure(let message): return message
        }
    }
}

let payloadFields = ["run_id", "gate_id", "content_hash", "decision", "nonce", "issued_at"]
let maximumKeyBlobSize = 16_384

func fail(_ message: String) -> ApprovalError { .failure(message) }

func securityError(_ operation: String, _ error: Unmanaged<CFError>?) -> ApprovalError {
    let detail = error?.takeRetainedValue().localizedDescription ?? "Security framework refused the operation."
    return fail("\(operation): \(detail)")
}

func writeJSON(_ value: [String: String]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([0x0a]))
}

func context(reason: String) throws -> LAContext {
    guard SecureEnclave.isAvailable else { throw fail("A Secure Enclave is required. No software fallback is permitted.") }
    let context = LAContext()
    context.touchIDAuthenticationAllowableReuseDuration = 0
    context.localizedFallbackTitle = ""
    context.localizedReason = reason
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error),
          context.biometryType == .touchID else {
        context.invalidate()
        throw fail("Touch ID must be available and enrolled. No password or software fallback is permitted.")
    }
    return context
}

func keyDirectory(create: Bool) throws -> Int32 {
    guard let account = getpwuid(geteuid()), let homePointer = account.pointee.pw_dir,
          let homePath = String(validatingUTF8: homePointer), homePath.hasPrefix("/"), homePath != "/" else {
        throw fail("Unable to resolve an absolute home directory for the current user.")
    }
    let home = URL(fileURLWithPath: homePath, isDirectory: true)
    let target = home.appendingPathComponent("Library/Application Support/q-core-touchid-approve", isDirectory: true)
    let components = target.pathComponents.filter { $0 != "/" }
    let homeComponents = home.pathComponents.filter { $0 != "/" }.count
    var descriptor = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC)
    guard descriptor >= 0 else { throw fail("Unable to open the approval-key directory.") }
    do {
        for (index, component) in components.enumerated() {
            var next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            if next < 0, errno == ENOENT, create, index >= homeComponents {
                guard mkdirat(descriptor, component, 0o700) == 0 || errno == EEXIST else {
                    throw fail("Unable to create the approval-key directory.")
                }
                next = openat(descriptor, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
            }
            guard next >= 0 else { throw fail("Approval-key directory components must be existing directories, never symlinks.") }
            Darwin.close(descriptor)
            descriptor = next
            var attributes = stat()
            guard fstat(descriptor, &attributes) == 0,
                  attributes.st_mode & mode_t(S_IFMT) == mode_t(S_IFDIR),
                  attributes.st_mode & 0o022 == 0 else {
                throw fail("The approval-key directory path must not be writable by other users or groups.")
            }
            if index >= homeComponents - 1 {
                guard attributes.st_uid == geteuid() else { throw fail("The approval-key directory path must belong to the current user.") }
            }
            if index == components.count - 1 {
                guard attributes.st_mode & 0o7777 == 0o700 else { throw fail("The approval-key directory must have permissions 0700.") }
            }
        }
        return descriptor
    } catch {
        Darwin.close(descriptor)
        throw error
    }
}

func readKeyBlob(directory: Int32) throws -> Data? {
    let descriptor = openat(directory, "enclave-key", O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC)
    if descriptor < 0, errno == ENOENT { return nil }
    guard descriptor >= 0 else { throw fail("Unable to open the enclave key. Symlinks are not permitted.") }
    defer { Darwin.close(descriptor) }
    var attributes = stat()
    guard fstat(descriptor, &attributes) == 0,
          attributes.st_mode & mode_t(S_IFMT) == mode_t(S_IFREG), attributes.st_nlink == 1,
          attributes.st_uid == geteuid(), attributes.st_mode & 0o7777 == 0o600,
          attributes.st_size > 0, attributes.st_size <= maximumKeyBlobSize else {
        throw fail("The enclave key must be a current-user regular file with permissions 0600, one link, and at most 16 KiB.")
    }
    var result = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while true {
        let count = Darwin.read(descriptor, &buffer, buffer.count)
        if count < 0, errno == EINTR { continue }
        guard count >= 0 else { throw fail("Unable to read the enclave key.") }
        if count == 0 { break }
        result.append(contentsOf: buffer.prefix(count))
        guard result.count <= maximumKeyBlobSize else { throw fail("The enclave key exceeds 16 KiB.") }
    }
    guard result.count == attributes.st_size else { throw fail("The enclave key changed while being read.") }
    return result
}

func writeKeyBlob(_ blob: Data, directory: Int32) throws {
    guard !blob.isEmpty, blob.count <= maximumKeyBlobSize else { throw fail("Unexpected enclave key size.") }
    let descriptor = openat(directory, "enclave-key", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
    guard descriptor >= 0 else { throw fail("Unable to create the enclave key; existing enrollment is never overwritten.") }
    defer { Darwin.close(descriptor) }
    guard fchmod(descriptor, 0o600) == 0 else { throw fail("Unable to protect the enclave-key file.") }
    try blob.withUnsafeBytes { bytes in
        var offset = 0
        while offset < bytes.count {
            let count = Darwin.write(descriptor, bytes.baseAddress!.advanced(by: offset), bytes.count - offset)
            if count < 0, errno == EINTR { continue }
            guard count > 0 else { throw fail("Unable to persist the enclave key. Manual recovery is required.") }
            offset += count
        }
    }
    guard fsync(descriptor) == 0, fsync(directory) == 0 else {
        throw fail("Unable to sync the enclave key. Manual recovery is required.")
    }
}

func createPrivateKey(context: LAContext) throws -> SecureEnclave.P256.Signing.PrivateKey {
    var error: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.biometryCurrentSet, .privateKeyUsage],
        &error
    ) else { throw securityError("Unable to configure biometric access control", error) }
    return try SecureEnclave.P256.Signing.PrivateKey(
        compactRepresentable: false,
        accessControl: access,
        authenticationContext: context
    )
}

func publicKeyPEM(_ key: SecureEnclave.P256.Signing.PrivateKey) throws -> String {
    let exported = key.publicKey.x963Representation
    guard exported.count == 65, exported.first == 0x04 else {
        throw fail("Unexpected P-256 public-key representation.")
    }
    // RFC 5480 SubjectPublicKeyInfo for id-ecPublicKey / prime256v1, followed by the X9.63 point.
    let header: [UInt8] = [
        0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
    ]
    let encoded = (Data(header) + exported).base64EncodedString()
    let lines = stride(from: 0, to: encoded.count, by: 64).map { offset -> String in
        let start = encoded.index(encoded.startIndex, offsetBy: offset)
        let end = encoded.index(start, offsetBy: min(64, encoded.count - offset))
        return String(encoded[start..<end])
    }
    return "-----BEGIN PUBLIC KEY-----\n" + lines.joined(separator: "\n") + "\n-----END PUBLIC KEY-----\n"
}

func quoteJSON(_ value: String) -> String {
    var result = "\""
    for scalar in value.unicodeScalars {
        switch scalar.value {
        case 0x22: result += "\\\""
        case 0x5c: result += "\\\\"
        case 0x08: result += "\\b"
        case 0x09: result += "\\t"
        case 0x0a: result += "\\n"
        case 0x0c: result += "\\f"
        case 0x0d: result += "\\r"
        case 0...0x1f: result += String(format: "\\u%04x", scalar.value)
        default: result.unicodeScalars.append(scalar)
        }
    }
    return result + "\""
}

func promptLabel(_ value: String) -> String {
    let escaped = value.unicodeScalars.map { scalar -> String in
        if (0x20...0x7e).contains(scalar.value) { return String(scalar) }
        return String(format: "\\u{%04X}", scalar.value)
    }.joined()
    return quoteJSON(escaped)
}

func readPayload() throws -> (Data, [String: String]) {
    var data = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: min(4_096, 16_385 - data.count)), !chunk.isEmpty {
        data.append(chunk)
        guard data.count <= 16_384 else { throw fail("The approval payload exceeds 16 KiB.") }
    }
    guard !data.isEmpty, String(data: data, encoding: .utf8) != nil,
          let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
          Set(object.keys) == Set(payloadFields) else {
        throw fail("Expected one canonical approval payload on stdin.")
    }
    var payload: [String: String] = [:]
    for field in payloadFields {
        guard let value = object[field] as? String else { throw fail("Every approval field must be a string.") }
        payload[field] = value
    }
    for field in ["run_id", "gate_id"] {
        guard let value = payload[field], !value.isEmpty, value.utf8.count <= 256 else {
            throw fail("Approval identifiers must contain 1 to 256 UTF-8 bytes.")
        }
    }
    for field in ["content_hash", "nonce"] {
        guard payload[field]?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw fail("\(field) must contain exactly 64 lowercase hexadecimal characters.")
        }
    }
    guard payload["decision"] == "approve" || payload["decision"] == "reject" else {
        throw fail("The decision must be approve or reject.")
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    formatter.timeZone = TimeZone(secondsFromGMT: 0)
    guard let issuedAt = payload["issued_at"],
          issuedAt.range(of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$", options: .regularExpression) != nil,
          let timestamp = formatter.date(from: issuedAt), formatter.string(from: timestamp) == issuedAt else {
        throw fail("issued_at must be a valid UTC ISO-8601 timestamp with milliseconds.")
    }
    let canonical = "{" + payloadFields.map { quoteJSON($0) + ":" + quoteJSON(payload[$0]!) }.joined(separator: ",") + "}"
    guard data == Data(canonical.utf8) else {
        throw fail("The payload must use canonical field order and JSON encoding, without a trailing newline.")
    }
    return (data, payload)
}

func setup() throws {
    var input = Data()
    while let chunk = try FileHandle.standardInput.read(upToCount: min(256, 1_025 - input.count)), !chunk.isEmpty {
        input.append(chunk)
        guard input.count <= 1_024 else { throw fail("The enrollment challenge exceeds 1 KiB.") }
    }
    guard let object = try JSONSerialization.jsonObject(with: input) as? [String: Any],
          Set(object.keys) == Set(["nonce"]), let nonce = object["nonce"] as? String,
          nonce.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
          input == Data(("{\"nonce\":" + quoteJSON(nonce) + "}").utf8) else {
        throw fail("Expected one canonical enrollment challenge with a 64-character lowercase hexadecimal nonce.")
    }
    let authentication = try context(reason: "Set up the Touch ID approval key")
    defer { authentication.invalidate() }
    let directory = try keyDirectory(create: true)
    defer { Darwin.close(directory) }
    let key: SecureEnclave.P256.Signing.PrivateKey
    if let blob = try readKeyBlob(directory: directory) {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: authentication)
    } else {
        key = try createPrivateKey(context: authentication)
        try writeKeyBlob(key.dataRepresentation, directory: directory)
    }
    let publicKey = try publicKeyPEM(key)
    let enrollment = "{\"purpose\":\"q-core.touchid-registration/v1\",\"public_key\":"
        + quoteJSON(publicKey) + ",\"nonce\":" + quoteJSON(nonce) + "}"
    let signature = try key.signature(for: Data(enrollment.utf8))
    try writeJSON(["public_key": publicKey, "signature": signature.derRepresentation.base64EncodedString()])
}

func approve() throws {
    let (data, payload) = try readPayload()
    let reason = "Decision: \(payload["decision"]!.uppercased())\nSHA-256: \(payload["content_hash"]!)\nRun: \(promptLabel(payload["run_id"]!))\nGate: \(promptLabel(payload["gate_id"]!))"
    let authentication = try context(reason: reason)
    defer { authentication.invalidate() }
    let directory = try keyDirectory(create: false)
    defer { Darwin.close(directory) }
    guard let blob = try readKeyBlob(directory: directory) else {
        throw fail("No Touch ID key is enrolled. Run q-core approver add touchid first.")
    }
    let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: blob, authenticationContext: authentication)
    let signature = try key.signature(for: data)
    try writeJSON(["signature": signature.derRepresentation.base64EncodedString()])
}

do {
    guard CommandLine.arguments.count == 2 else { throw fail("Usage: touchid-approve setup|approve") }
    switch CommandLine.arguments[1] {
    case "setup": try setup()
    case "approve": try approve()
    default: throw fail("Usage: touchid-approve setup|approve")
    }
} catch {
    FileHandle.standardError.write(Data("touchid-approve: \(error)\n".utf8))
    exit(1)
}
