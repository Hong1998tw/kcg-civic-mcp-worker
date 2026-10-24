import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, link, unlink } from "node:fs/promises";
import { lstatSync } from "node:fs";
import path from "node:path";

const MAGIC = Buffer.from("KCGDERIV2\n", "ascii");
const MAX_HEADER_BYTES = 8 * 1024;
export const MAX_DERIVED_OBJECT_BYTES = 64 * 1024 * 1024;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATASETS = new Set([
  "kcc-proposal-details",
  "kcc-proposal-attachments",
  "kcc-meeting-records",
]);

export class DerivedStoreError extends Error {
  constructor(reasonCode, message) {
    super(`${reasonCode}: ${message}`);
    this.name = "DerivedStoreError";
    this.reasonCode = reasonCode;
  }
}

function fail(message) {
  throw new DerivedStoreError("SNAPSHOT_UNVERIFIED", message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) fail("derived object binding 格式無效");
  const { kind, dataset, id, source, raw_sha256, schema_version } = binding;
  if (typeof kind !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(kind) ||
      typeof dataset !== "string" || !DATASETS.has(dataset) ||
      typeof id !== "string" || !/^[A-Za-z0-9._:#/-]{1,512}$/.test(id) ||
      typeof source !== "string" || !source || source.length > 4096 ||
      typeof raw_sha256 !== "string" || !SHA256_RE.test(raw_sha256) ||
      typeof schema_version !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(schema_version)) {
    fail("derived object kind/dataset/id/source/raw/schema binding 無效");
  }
  return { format: "local-derived-v2", kind, dataset, id, source, raw_sha256, schema_version };
}

function normalizeExpectedBinding(binding) {
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) fail("derived expected binding 格式無效");
  const allowed = new Set(["format", "kind", "dataset", "id", "source", "raw_sha256", "schema_version"]);
  for (const key of Object.keys(binding)) if (!allowed.has(key)) fail(`derived expected binding 不支援 ${key}`);
  if (binding.format !== undefined && binding.format !== "local-derived-v2") fail("derived expected format 無效");
  if (binding.source === undefined) {
    const { kind, dataset, id, raw_sha256, schema_version } = binding;
    const full = normalizeBinding({ kind, dataset, id, source: "derived-source-placeholder", raw_sha256, schema_version });
    const result = { ...full };
    delete result.source;
    delete result.format;
    return result;
  }
  const result = normalizeBinding(binding);
  delete result.format;
  return result;
}

function normalizeRef(ref) {
  if (!ref || typeof ref !== "object" || Array.isArray(ref) ||
      Object.keys(ref).length !== 2 || !SHA256_RE.test(ref.sha256) ||
      !Number.isSafeInteger(ref.byte_length) || ref.byte_length < MAGIC.length + 4 ||
      ref.byte_length > MAX_DERIVED_OBJECT_BYTES) {
    fail("derived ref 僅允許有效 sha256 與 byte_length");
  }
  return { sha256: ref.sha256, byte_length: ref.byte_length };
}

function bodyBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "string") return Buffer.from(value, "utf8");
  return null;
}

function headerBytes(binding, bodyByteLength) {
  if (!Number.isSafeInteger(bodyByteLength) || bodyByteLength < 0) fail("derived body byte_length 無效");
  const header = Buffer.from(canonical({ ...normalizeBinding(binding), body_byte_length: bodyByteLength }), "utf8");
  if (!header.length || header.length > MAX_HEADER_BYTES) fail("derived header 超過大小上限");
  const prefix = Buffer.allocUnsafe(MAGIC.length + 4);
  MAGIC.copy(prefix);
  prefix.writeUInt32BE(header.length, MAGIC.length);
  return { header, prefix };
}

function signature(info) {
  return [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeNs, info.ctimeNs].join(":");
}

function assertPlainDirectory(directory, label) {
  let info;
  try { info = lstatSync(directory); } catch (error) {
    if (error?.code === "ENOENT") throw new DerivedStoreError("LOCAL_DATA_UNAVAILABLE", `${label}不存在`);
    throw new DerivedStoreError("LOCAL_DATA_UNAVAILABLE", `${label}無法檢查`);
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label}必須是一般目錄，拒絕 symlink`);
}

function assertNoSymlinkEntry(filePath, label) {
  try {
    const info = lstatSync(filePath);
    if (info.isSymbolicLink()) fail(`${label}不可為 symlink`);
    return info;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeAll(file, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset, null);
    if (!result.bytesWritten) fail("derived CAS 寫入未前進");
    offset += result.bytesWritten;
  }
}

async function readExact(file, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const result = await file.read(buffer, offset, buffer.length - offset, position + offset);
    if (!result.bytesRead) fail("derived CAS header 截斷");
    offset += result.bytesRead;
  }
}

export class DerivedStore {
  constructor(root, options = {}) {
    if (typeof root !== "string" || !root.trim()) throw new TypeError("DerivedStore root is required");
    this.root = path.resolve(root);
    this.readOnly = options.readOnly !== false;
    if (this.readOnly) assertPlainDirectory(this.root, "本機資料根目錄");
  }

  static calculateRef({ kind, dataset, id, source, raw_sha256, schema_version, body }) {
    const bytes = bodyBytes(body);
    if (!bytes) fail("calculateRef body 必須是 UTF-8 bytes 或字串");
    const binding = { kind, dataset, id, source, raw_sha256, schema_version };
    const { header, prefix } = headerBytes(binding, bytes.length);
    const digest = createHash("sha256").update(prefix).update(header).update(bytes).digest("hex");
    return { sha256: digest, byte_length: prefix.length + header.length + bytes.length };
  }

  objectPath(hash) {
    if (typeof hash !== "string" || !SHA256_RE.test(hash)) fail("derived SHA-256 格式無效");
    return path.join(this.root, "derived", "sha256", hash.slice(0, 2), `${hash}.obj`);
  }

  async putObject(input) {
    if (this.readOnly) throw new DerivedStoreError("LOCAL_DATA_UNAVAILABLE", "query runtime 使用唯讀 derived store");
    const binding = normalizeBinding(input);
    const body = bodyBytes(input.body);
    if (!body) throw new TypeError("putObject body must be Buffer, Uint8Array, or UTF-8 string");
    const ref = DerivedStore.calculateRef({ ...binding, body });
    const bodyMax = Number.isSafeInteger(input.maxBytes) ? input.maxBytes : MAX_DERIVED_OBJECT_BYTES;
    if (body.length > bodyMax || ref.byte_length > MAX_DERIVED_OBJECT_BYTES) fail("derived object 超過大小上限");
    await this.#writeObject(binding, body, ref);
    return ref;
  }

  async putObjectStream(input) {
    if (this.readOnly) throw new DerivedStoreError("LOCAL_DATA_UNAVAILABLE", "query runtime 使用唯讀 derived store");
    const binding = normalizeBinding(input);
    const bodyLength = Number(input.body_byte_length);
    if (!Number.isSafeInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_DERIVED_OBJECT_BYTES) fail("stream body_byte_length 無效");
    const { header, prefix } = headerBytes(binding, bodyLength);
    const totalLength = prefix.length + header.length + bodyLength;
    if (totalLength > MAX_DERIVED_OBJECT_BYTES) fail("derived object 超過大小上限");
    const hash = createHash("sha256").update(prefix).update(header);
    const tempSeed = createHash("sha256").update(prefix).update(header).digest("hex");
    return await this.#writeStreamAndHash(binding, input.body, bodyLength, prefix, header, hash, tempSeed);
  }

  async #writeStreamAndHash(binding, source, bodyLength, prefix, header, hash, tempSeed) {
    if (!source || typeof source[Symbol.asyncIterator] !== "function") fail("putObjectStream body 必須是 AsyncIterable");
    const { rootDir, shardDir: tempDir } = await this.#ensureDirectories(tempSeed);
    const temporary = path.join(tempDir, `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    let written = 0;
    try {
      await writeAll(file, prefix);
      await writeAll(file, header);
      for await (const value of source) {
        const chunk = bodyBytes(value);
        if (!chunk || !chunk.length) continue;
        written += chunk.length;
        if (written > bodyLength) fail("derived stream 超過宣告 byte_length");
        hash.update(chunk);
        await writeAll(file, chunk);
      }
      if (written !== bodyLength) fail("derived stream 與宣告 byte_length 不一致");
      await file.sync();
    } catch (error) {
      await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await file.close();
    const ref = { sha256: hash.digest("hex"), byte_length: prefix.length + header.length + bodyLength };
    const { shardDir } = await this.#ensureDirectories(ref.sha256);
    const destination = path.join(shardDir, `${ref.sha256}.obj`);
    await this.#installTemp(temporary, destination, ref, binding);
    const dir = await open(shardDir, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    assertPlainDirectory(rootDir, "derived CAS 根目錄");
    return ref;
  }

  async #writeObject(binding, body, ref) {
    const { header, prefix } = headerBytes(binding, body.length);
    const destination = this.objectPath(ref.sha256);
    const { rootDir, shardDir } = await this.#ensureDirectories(ref.sha256);
    const existing = assertNoSymlinkEntry(destination, "既有 derived object");
    if (existing) {
      await this.verifyObject(ref, binding);
      return ref;
    }
    const temporary = path.join(shardDir, `.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await writeAll(file, prefix);
      await writeAll(file, header);
      await writeAll(file, body);
      await file.sync();
    } catch (error) {
      await file.close();
      await unlink(temporary).catch(() => {});
      throw error;
    }
    await file.close();
    await this.#installTemp(temporary, destination, ref, binding);
    const dir = await open(shardDir, "r");
    try { await dir.sync(); } finally { await dir.close(); }
    assertPlainDirectory(rootDir, "derived CAS 根目錄");
    return ref;
  }

  async #installTemp(temporary, destination, ref, binding) {
    try {
      await link(temporary, destination);
    } catch (error) {
      if (error?.code === "EEXIST") {
        await this.verifyObject(ref, binding);
        return;
      }
      if (["EPERM", "ENOTSUP", "EOPNOTSUPP"].includes(error?.code)) {
        throw new DerivedStoreError("LOCAL_DATA_UNAVAILABLE", "檔案系統不支援安全的 derived CAS 原子安裝");
      }
      throw error;
    } finally {
      await unlink(temporary).catch(() => {});
    }
  }

  async #ensureDirectories(hash) {
    const rootDir = this.root;
    const derivedDir = path.join(rootDir, "derived");
    const shaDir = path.join(derivedDir, "sha256");
    const shardDir = path.join(shaDir, hash.slice(0, 2));
    for (const directory of [rootDir, derivedDir, shaDir, shardDir]) {
      try { await mkdir(directory); } catch (error) { if (error?.code !== "EEXIST") throw error; }
      assertPlainDirectory(directory, "derived CAS 路徑");
    }
    return { rootDir, shardDir };
  }

  async verifyObject(refInput, expected) {
    const ref = normalizeRef(refInput);
    const binding = normalizeBinding(expected);
    const file = await this.#openObject(ref, binding);
    try {
      const result = await this.#scanOpenObject(file, ref, binding, false);
      return result;
    } finally {
      await file.close();
    }
  }

  async readObject(refInput, expected, options = {}) {
    const ref = normalizeRef(refInput);
    const binding = normalizeBinding(expected);
    const maxBytes = options.maxBytes === undefined ? MAX_DERIVED_OBJECT_BYTES : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DERIVED_OBJECT_BYTES) fail("derived read maxBytes 無效");
    const file = await this.#openObject(ref, binding);
    try {
      const { header, bodyOffset } = await this.#readAndVerifyHeader(file, ref, binding);
      if (header.body_byte_length > maxBytes) throw new DerivedStoreError("PARTIAL_SCAN", "derived object body 超過讀取上限");
      const body = Buffer.allocUnsafe(header.body_byte_length);
      await readExact(file, body, bodyOffset);
      await this.#verifyFileDigest(file, ref, bodyOffset, header.body_byte_length, body);
      return body;
    } finally {
      await file.close();
    }
  }

  async readBoundObject(refInput, expected, options = {}) {
    const ref = normalizeRef(refInput);
    const expectedBinding = normalizeExpectedBinding(expected);
    const maxBytes = options.maxBytes === undefined ? MAX_DERIVED_OBJECT_BYTES : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DERIVED_OBJECT_BYTES) fail("derived read maxBytes 無效");
    const file = await this.#openObject(ref, expectedBinding);
    try {
      const { header } = await this.#readAndVerifyHeader(file, ref, expectedBinding);
      if (header.body_byte_length > maxBytes) throw new DerivedStoreError("PARTIAL_SCAN", "derived object body 超過讀取上限");
      const scanned = await this.#scanOpenObject(file, ref, expectedBinding, true);
      return { binding: scanned.binding, body: scanned.body };
    } finally {
      await file.close();
    }
  }

  async *readObjectStream(refInput, expected, options = {}) {
    const ref = normalizeRef(refInput);
    const binding = normalizeBinding(expected);
    const chunkBytes = options.chunkBytes === undefined ? 64 * 1024 : Number(options.chunkBytes);
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1024 || chunkBytes > 1024 * 1024) fail("derived stream chunkBytes 無效");
    const maxBytes = options.maxBytes === undefined ? MAX_DERIVED_OBJECT_BYTES : Number(options.maxBytes);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_DERIVED_OBJECT_BYTES) fail("derived stream maxBytes 無效");
    const file = await this.#openObject(ref, binding);
    try {
      const { header, bodyOffset } = await this.#readAndVerifyHeader(file, ref, binding);
      if (header.body_byte_length > maxBytes) throw new DerivedStoreError("PARTIAL_SCAN", "derived object body 超過串流上限");
      const scanned = await this.#scanOpenObject(file, ref, binding, true);
      for (let offset = 0; offset < scanned.body.length; offset += chunkBytes) {
        yield scanned.body.subarray(offset, Math.min(offset + chunkBytes, scanned.body.length));
      }
    } finally {
      await file.close();
    }
  }

  async #openObject(ref, binding) {
    const filePath = this.objectPath(ref.sha256);
    assertPlainDirectory(this.root, "本機資料根目錄");
    for (const directory of [path.join(this.root, "derived"), path.join(this.root, "derived", "sha256"), path.dirname(filePath)]) {
      assertPlainDirectory(directory, "derived CAS 路徑");
    }
    let pathInfo;
    try { pathInfo = await lstat(filePath, { bigint: true }); } catch (error) {
      if (error?.code === "ENOENT") throw new DerivedStoreError("SNAPSHOT_UNVERIFIED", `缺少 derived object ${ref.sha256}`);
      throw error;
    }
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1n || Number(pathInfo.size) !== ref.byte_length) {
      fail(`derived object ${ref.sha256} 路徑、hardlink 或長度無效`);
    }
    let file;
    try { file = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ELOOP") fail(`derived object ${ref.sha256} 無法安全開啟`);
      throw error;
    }
    try {
      const fdInfo = await file.stat({ bigint: true });
      if (!fdInfo.isFile() || fdInfo.nlink !== 1n || signature(fdInfo) !== signature(pathInfo)) fail("derived object 開啟時路徑改變");
      file._derivedPath = filePath;
      file._derivedSignature = signature(fdInfo);
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  async #readAndVerifyHeader(file, ref, expected) {
    const prefix = Buffer.allocUnsafe(MAGIC.length + 4);
    await readExact(file, prefix, 0);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) fail("derived object magic/version 無效");
    const headerLength = prefix.readUInt32BE(MAGIC.length);
    if (headerLength < 2 || headerLength > MAX_HEADER_BYTES) fail("derived object header 長度無效");
    const headerBytesValue = Buffer.allocUnsafe(headerLength);
    await readExact(file, headerBytesValue, prefix.length);
    let header;
    try { header = JSON.parse(headerBytesValue.toString("utf8")); } catch { fail("derived object header JSON 無效"); }
    if (canonical(header) !== headerBytesValue.toString("utf8") || !Number.isSafeInteger(header.body_byte_length) || header.body_byte_length < 0) {
      fail("derived object header 非 canonical 或長度無效");
    }
    const actualBinding = normalizeBinding(header);
    const binding = normalizeExpectedBinding(expected);
    for (const [key, value] of Object.entries(binding)) if (actualBinding[key] !== value) fail(`derived object ${key} 綁定不一致`);
    if (header.format !== "local-derived-v2" || header.body_byte_length + prefix.length + headerLength !== ref.byte_length) {
      fail("derived object header 與 ref byte_length 不一致");
    }
    await this.#assertStable(file, file._derivedSignature);
    return { header: { ...actualBinding, body_byte_length: header.body_byte_length }, bodyOffset: prefix.length + headerLength };
  }

  async #scanOpenObject(file, ref, binding, collect) {
    const { header, bodyOffset } = await this.#readAndVerifyHeader(file, ref, binding);
    const digest = createHash("sha256");
    const prefix = Buffer.allocUnsafe(MAGIC.length + 4);
    await readExact(file, prefix, 0);
    const headerBytesValue = Buffer.allocUnsafe(bodyOffset - prefix.length);
    await readExact(file, headerBytesValue, prefix.length);
    digest.update(prefix).update(headerBytesValue);
    const body = collect ? Buffer.allocUnsafe(header.body_byte_length) : null;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = bodyOffset;
    let remaining = header.body_byte_length;
    while (remaining > 0) {
      const target = chunk.subarray(0, Math.min(chunk.length, remaining));
      await readExact(file, target, position);
      digest.update(target);
      if (collect) body.set(target, position - bodyOffset);
      position += target.length;
      remaining -= target.length;
    }
    const resultHash = digest.digest("hex");
    if (resultHash !== ref.sha256) fail(`derived object ${ref.sha256} SHA-256 不一致`);
    await this.#assertStable(file, file._derivedSignature);
    return {
      sha256: resultHash,
      byte_length: ref.byte_length,
      body_byte_length: header.body_byte_length,
      binding: { ...header },
      body,
    };
  }

  async #verifyFileDigest(file, ref, bodyOffset, bodyByteLength, knownBody) {
    const digest = createHash("sha256");
    const prefix = Buffer.allocUnsafe(MAGIC.length + 4);
    await readExact(file, prefix, 0);
    const headerBytesValue = Buffer.allocUnsafe(bodyOffset - prefix.length);
    await readExact(file, headerBytesValue, prefix.length);
    digest.update(prefix).update(headerBytesValue);
    if (knownBody) {
      digest.update(knownBody);
    } else {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      let position = bodyOffset;
      let remaining = bodyByteLength;
      while (remaining > 0) {
        const target = chunk.subarray(0, Math.min(chunk.length, remaining));
        await readExact(file, target, position);
        digest.update(target);
        position += target.length;
        remaining -= target.length;
      }
    }
    if (digest.digest("hex") !== ref.sha256) fail(`derived object ${ref.sha256} SHA-256 不一致`);
    await this.#assertStable(file, file._derivedSignature);
  }

  async #assertStable(file, expectedSignature) {
    const fdInfo = await file.stat({ bigint: true });
    if (!fdInfo.isFile() || fdInfo.nlink !== 1n || signature(fdInfo) !== expectedSignature) fail("derived object 驗證期間改變或出現 hardlink");
    const pathInfo = await lstat(file._derivedPath, { bigint: true });
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.nlink !== 1n || signature(pathInfo) !== expectedSignature) {
      fail("derived object 路徑在驗證期間改變");
    }
  }
}
