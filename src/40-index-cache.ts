function invalidateContactIndex(contactsDir: string) {
  const cacheKey = path.resolve(contactsDir);
  const entry = contactIndexCache.get(cacheKey);
  if (!entry) return;
  entry.version += 1;
  entry.value = undefined;
  entry.expiresAt = 0;
}

function ensureContactIndexWatcher(
  contactsDir: string,
  entry: ContactIndexCacheEntry,
  cacheTtlMs: number,
) {
  if (cacheTtlMs === 0 || entry.watcher) return;
  try {
    const watcher = watch(contactsDir, { persistent: false }, () => {
      invalidateContactIndex(contactsDir);
    });
    watcher.on('error', () => {
      watcher.close();
      if (entry.watcher === watcher) entry.watcher = undefined;
      entry.version += 1;
      entry.value = undefined;
      entry.expiresAt = 0;
    });
    entry.watcher = watcher;
  } catch {
    // The TTL still self-heals if this platform cannot watch the directory.
  }
}

async function getContactIndex(
  contactsDir: string,
  options: IdentityResolutionOptions,
): Promise<ContactIndex> {
  const cacheKey = path.resolve(contactsDir);
  const optionsKey = `${options.cacheTtlMs}:${options.maxFiles}:${options.scanConcurrency}`;
  let entry = contactIndexCache.get(cacheKey);

  if (!entry) {
    entry = { expiresAt: 0, version: 0, optionsKey };
    contactIndexCache.set(cacheKey, entry);
  } else if (entry.optionsKey !== optionsKey) {
    entry.optionsKey = optionsKey;
    entry.version += 1;
    entry.value = undefined;
    entry.expiresAt = 0;
  }

  ensureContactIndexWatcher(contactsDir, entry, options.cacheTtlMs);
  const now = Date.now();
  if (entry.value && now < entry.expiresAt) return entry.value;
  if (entry.loading) return entry.loading;

  const versionAtStart = entry.version;
  const loading = buildContactIndex(contactsDir, {
    maxFiles: options.maxFiles,
    scanConcurrency: options.scanConcurrency,
  });
  entry.loading = loading;

  try {
    const index = await loading;
    if (entry.version === versionAtStart && options.cacheTtlMs > 0) {
      entry.value = index;
      entry.expiresAt = Date.now() + options.cacheTtlMs;
    }
    return index;
  } finally {
    if (entry.loading === loading) entry.loading = undefined;
  }
}

function clearRuntimeCaches() {
  for (const entry of contactIndexCache.values()) entry.watcher?.close();
  contactIndexCache.clear();
  fileMutationQueues.clear();
  loggedIssues.clear();
  openClawConfigCache = undefined;
}

async function resolveContactProfile(params: {
  contactsDir: string;
  channel: string;
  id: string;
  options?: Partial<IdentityResolutionOptions>;
}): Promise<ContactResolution> {
  const legacyPath = safeProfileFilePath(params.contactsDir, params.channel, params.id);
  const identity = normalizeIdentity(params.channel, params.id);
  if (!legacyPath || !identity) return { status: 'invalid' };

  const options: IdentityResolutionOptions = {
    enabled: params.options?.enabled !== false,
    cacheTtlMs: boundedInteger(
      params.options?.cacheTtlMs,
      DEFAULT_IDENTITY_CACHE_TTL_MS,
      0,
      3_600_000,
    ),
    maxFiles: boundedInteger(
      params.options?.maxFiles,
      DEFAULT_IDENTITY_MAX_FILES,
      1,
      100_000,
    ),
    scanConcurrency: boundedInteger(
      params.options?.scanConcurrency,
      DEFAULT_IDENTITY_SCAN_CONCURRENCY,
      1,
      16,
    ),
  };

  if (options.enabled) {
    try {
      const index = await getContactIndex(params.contactsDir, options);
      const collisions = index.collisions.get(identity);
      if (collisions) {
        const basenames = collisions.map((filePath) => path.basename(filePath));
        logIssueOnce(
          `collision:${identity}:${basenames.join(',')}`,
          `[profile-injector] Identity collision for ${identity}; refusing to choose between ${basenames.join(', ')}`,
        );
        return { status: 'collision', identity, collisions };
      }

      const indexedPath = index.byIdentity.get(identity);
      if (indexedPath) return { status: 'resolved', identity, filePath: indexedPath };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logIssueOnce(
        `index-error:${params.contactsDir}:${message}`,
        `[profile-injector] Contact index unavailable; using exact-path fallback: ${message}`,
      );
    }
  }

  if (await fileExists(legacyPath)) {
    return { status: 'legacy', identity, filePath: legacyPath };
  }
  return { status: 'missing', identity, filePath: legacyPath };
}
