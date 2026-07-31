// Generated from the ordered src/*.ts files by scripts/build.mjs. Do not edit directly.
import { watch } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
const DEFAULT_CONTACT_DIR = 'memory/contacts';
const DEFAULT_GROUP_DIR = 'memory/groups';
const DEFAULT_CONTACT_TEMPLATE = 'memory/contacts/_EXAMPLE-contact.md';
const DEFAULT_CHANNEL_TEMPLATE = 'memory/groups/_EXAMPLE-channel.md';
const DEFAULT_IDENTITY_CACHE_TTL_MS = 60_000;
const DEFAULT_IDENTITY_MAX_FILES = 1_000;
const DEFAULT_IDENTITY_SCAN_CONCURRENCY = 4;
const DEFAULT_GROUP_MAX_CONTACTS = 10;
const DEFAULT_GROUP_MAX_TOTAL_CHARS = 30_000;
const CONFIG_CACHE_TTL_MS = 1_000;
const MAX_PROFILE_ID_CHARS = 320;
const PHONE_CHANNELS = new Set([
    'bluebubbles',
    'imessage',
    'phone',
    'rcs',
    'signal',
    'sms',
    'whatsapp'
]);
const contactIndexCache = new Map();
const fileMutationQueues = new Map();
const loggedIssues = new Set();
let openClawConfigCache;
function logIssueOnce(key, message) {
    if (loggedIssues.has(key)) return;
    loggedIssues.add(key);
    console.error(message);
}
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch  {
        return false;
    }
}
function boundedInteger(value, fallback, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
function profileDepth(value) {
    return value === 'small' || value === 'medium' || value === 'full' ? value : 'full';
}
function isSafeProfileId(value) {
    return value.length > 0 && value.length <= MAX_PROFILE_ID_CHARS && value !== '.' && value !== '..' && !/[\0\r\n/\\]/u.test(value) && !/^\s|\s$/u.test(value);
}
function isPlaceholderIdentity(channel, value) {
    const normalizedChannel = channel.toLowerCase();
    const normalizedValue = value.toLowerCase();
    return normalizedChannel.includes('<') || normalizedChannel.includes('>') || normalizedValue.includes('<user_id>') || normalizedValue.includes('<group_id>') || normalizedValue === 'unknown' || normalizedValue.endsWith('-todo');
}
function normalizeIdentity(channelOrIdentity, maybeId) {
    let channel;
    let value;
    if (maybeId === undefined) {
        const separator = channelOrIdentity.indexOf(':');
        if (separator <= 0 || separator === channelOrIdentity.length - 1) return null;
        channel = channelOrIdentity.slice(0, separator).trim();
        value = channelOrIdentity.slice(separator + 1).trim();
    } else {
        channel = channelOrIdentity.trim();
        value = maybeId.trim();
    }
    channel = channel.toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel) || !isSafeProfileId(value)) return null;
    if (isPlaceholderIdentity(channel, value)) return null;
    if (PHONE_CHANNELS.has(channel) && value.startsWith('+')) {
        const digits = value.slice(1).replace(/[\s().-]/gu, '');
        if (!/^\d{7,15}$/u.test(digits)) return null;
        value = `+${digits}`;
    } else if (PHONE_CHANNELS.has(channel) && value.includes('@')) {
        value = value.toLowerCase();
    } else if (channel === 'twitter' || channel === 'x') {
        value = value.replace(/^@/u, '').toLowerCase();
    }
    return `${channel}:${value}`;
}
function parseSessionAddress(sessionKey) {
    const parts = sessionKey.split(':');
    if (parts[0] !== 'agent' || parts.length < 5) return null;
    const channel = parts[2]?.trim().toLowerCase();
    const type = parts[3];
    const id = parts[4]?.trim();
    if (!channel || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel)) return null;
    if (type !== 'direct' && type !== 'group' && type !== 'channel') return null;
    if (!id || !isSafeProfileId(id)) return null;
    return {
        channel,
        type,
        id
    };
}
function parseYamlScalar(rawValue) {
    const value = rawValue.trim();
    if (!value) return null;
    if (value.startsWith('"') && value.endsWith('"')) {
        try {
            const parsed = JSON.parse(value);
            return typeof parsed === 'string' ? parsed : String(parsed);
        } catch  {
            return null;
        }
    }
    if (value.startsWith("'") && value.endsWith("'")) {
        return value.slice(1, -1).replace(/''/gu, "'");
    }
    return value;
}
function extractFrontmatter(content) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
    return match?.[1] ?? null;
}
function getFrontmatterScalar(frontmatter, key) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const match = frontmatter.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'mu'));
    return match?.[1] ? parseYamlScalar(match[1]) : null;
}
function getFrontmatterList(frontmatter, key) {
    const lines = frontmatter.split(/\r?\n/u);
    const keyPattern = new RegExp(`^${key}:\\s*(.*?)\\s*$`, 'u');
    const keyIndex = lines.findIndex((line)=>keyPattern.test(line));
    if (keyIndex < 0) return [];
    const keyMatch = lines[keyIndex]?.match(keyPattern);
    const inline = keyMatch?.[1]?.trim() ?? '';
    if (inline.startsWith('[') && inline.endsWith(']')) {
        try {
            const parsed = JSON.parse(inline);
            if (Array.isArray(parsed)) return parsed.map(String);
        } catch  {
            return inline.slice(1, -1).split(',').map((item)=>parseYamlScalar(item)).filter((item)=>item !== null);
        }
    }
    const values = [];
    for(let index = keyIndex + 1; index < lines.length; index += 1){
        const line = lines[index] ?? '';
        if (!/^\s+-\s+/u.test(line)) break;
        const parsed = parseYamlScalar(line.replace(/^\s+-\s+/u, ''));
        if (parsed !== null) values.push(parsed);
    }
    return values;
}
function extractContactIdentities(content) {
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) return [];
    const candidates = [
        getFrontmatterScalar(frontmatter, 'id'),
        ...getFrontmatterList(frontmatter, 'identities')
    ];
    const identities = new Set();
    for (const candidate of candidates){
        if (!candidate) continue;
        const normalized = normalizeIdentity(candidate);
        if (normalized) identities.add(normalized);
    }
    return [
        ...identities
    ];
}
function getMemberIds(content) {
    const frontmatter = extractFrontmatter(content);
    if (!frontmatter) return [];
    const uniqueIds = new Set();
    for (const id of getFrontmatterList(frontmatter, 'members')){
        if (isSafeProfileId(id)) uniqueIds.add(id);
    }
    return [
        ...uniqueIds
    ];
}
function addMemberToFrontmatter(content, senderId) {
    if (!isSafeProfileId(senderId) || getMemberIds(content).includes(senderId)) return null;
    const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
    if (!match) return null;
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const lines = (match[2] ?? '').split(/\r?\n/u);
    const memberLine = `  - ${JSON.stringify(senderId)}`;
    const keyIndex = lines.findIndex((line)=>/^members:\s*/u.test(line));
    if (keyIndex < 0) {
        if (lines.at(-1)?.trim()) lines.push('');
        lines.push('members:', memberLine);
    } else {
        const inline = lines[keyIndex]?.match(/^members:\s*(.*?)\s*$/u)?.[1] ?? '';
        if (inline === '[]') {
            lines[keyIndex] = 'members:';
            lines.splice(keyIndex + 1, 0, memberLine);
        } else if (inline === '') {
            let insertIndex = keyIndex + 1;
            while(insertIndex < lines.length && /^\s+-\s+/u.test(lines[insertIndex] ?? '')){
                insertIndex += 1;
            }
            lines.splice(insertIndex, 0, memberLine);
        } else if (inline.startsWith('[')) {
            const existing = getMemberIds(content);
            lines[keyIndex] = 'members:';
            lines.splice(keyIndex + 1, 0, ...existing.map((id)=>`  - ${JSON.stringify(id)}`), memberLine);
        } else {
            return null;
        }
    }
    const updatedFrontmatter = lines.join(lineEnding);
    return `${match[1]}${updatedFrontmatter}${match[3]}${content.slice(match[0].length)}`;
}
function capContent(content, depth, maxChars = Number.POSITIVE_INFINITY) {
    const suffix = '\n\n... (profile truncated by profile-injector)';
    let capped = content;
    if (depth !== 'full') {
        const lines = content.split('\n');
        const lineCap = depth === 'small' ? 15 : 40;
        if (lines.length > lineCap) capped = `${lines.slice(0, lineCap).join('\n')}${suffix}`;
    }
    if (Number.isFinite(maxChars) && capped.length > maxChars) {
        const budget = Math.max(0, Math.floor(maxChars));
        if (budget <= suffix.length) return capped.slice(0, budget);
        capped = `${capped.slice(0, budget - suffix.length).trimEnd()}${suffix}`;
    }
    return capped;
}
function isPathInside(rootPath, candidatePath) {
    const relative = path.relative(path.resolve(rootPath), path.resolve(candidatePath));
    return relative === '' || !relative.startsWith('..') && !path.isAbsolute(relative);
}
function resolveWorkspacePath(workspaceDir, configuredPath, fallbackRelativePath) {
    const relativePath = typeof configuredPath === 'string' && configuredPath.trim() ? configuredPath.trim() : fallbackRelativePath;
    const resolved = path.resolve(workspaceDir, relativePath);
    if (isPathInside(workspaceDir, resolved)) return resolved;
    logIssueOnce(`unsafe-workspace-path:${relativePath}`, `[profile-injector] Ignoring path outside workspace: ${relativePath}`);
    return path.resolve(workspaceDir, fallbackRelativePath);
}
function resolveProfileDirectories(workspaceDir, hookConfig) {
    return {
        contactsDir: resolveWorkspacePath(workspaceDir, hookConfig?.contactDir ?? hookConfig?.contactsDir, DEFAULT_CONTACT_DIR),
        groupsDir: resolveWorkspacePath(workspaceDir, hookConfig?.groupDir ?? hookConfig?.groupsDir, DEFAULT_GROUP_DIR)
    };
}
function safeProfileFilePath(directory, channel, id) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(channel) || !isSafeProfileId(id)) return null;
    const filePath = path.resolve(directory, `${channel}-${id}.md`);
    return isPathInside(directory, filePath) ? filePath : null;
}
function identityResolutionOptions(hookConfig) {
    const config = hookConfig?.identityResolution ?? {};
    return {
        enabled: config.enabled !== false,
        cacheTtlMs: boundedInteger(config.cacheTtlMs, DEFAULT_IDENTITY_CACHE_TTL_MS, 0, 3_600_000),
        maxFiles: boundedInteger(config.maxFiles, DEFAULT_IDENTITY_MAX_FILES, 1, 100_000),
        scanConcurrency: boundedInteger(config.scanConcurrency, DEFAULT_IDENTITY_SCAN_CONCURRENCY, 1, 16)
    };
}
async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    async function worker() {
        while(nextIndex < items.length){
            const index = nextIndex;
            nextIndex += 1;
            results[index] = await mapper(items[index]);
        }
    }
    const workerCount = Math.min(items.length, Math.max(1, concurrency));
    await Promise.all(Array.from({
        length: workerCount
    }, ()=>worker()));
    return results;
}
async function buildContactIndex(contactsDir, options = {}) {
    const started = process.hrtime.bigint();
    const maxFiles = boundedInteger(options.maxFiles, DEFAULT_IDENTITY_MAX_FILES, 1, 100_000);
    const directoryEntries = await fs.readdir(contactsDir, {
        withFileTypes: true
    });
    const files = directoryEntries.filter((entry)=>entry.isFile() && entry.name.endsWith('.md') && !entry.name.startsWith('_')).map((entry)=>entry.name).sort();
    if (files.length > maxFiles) {
        throw new Error(`contact index limit exceeded (${files.length} > ${maxFiles})`);
    }
    const scanConcurrency = boundedInteger(options.scanConcurrency, DEFAULT_IDENTITY_SCAN_CONCURRENCY, 1, 16);
    const parsedFiles = await mapWithConcurrency(files, scanConcurrency, async (fileName)=>{
        const filePath = path.join(contactsDir, fileName);
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            const identities = extractContactIdentities(content);
            const rawFrontmatter = extractFrontmatter(content);
            const rawCandidateCount = rawFrontmatter ? (getFrontmatterScalar(rawFrontmatter, 'id') ? 1 : 0) + getFrontmatterList(rawFrontmatter, 'identities').length : 0;
            return {
                filePath,
                identities,
                ignored: Math.max(0, rawCandidateCount - identities.length)
            };
        } catch  {
            return null;
        }
    });
    const claims = new Map();
    let parsedFileCount = 0;
    let ignoredIdentityCount = 0;
    for (const parsed of parsedFiles){
        if (!parsed) continue;
        parsedFileCount += 1;
        ignoredIdentityCount += parsed.ignored;
        for (const identity of parsed.identities){
            const identityClaims = claims.get(identity) ?? new Set();
            identityClaims.add(parsed.filePath);
            claims.set(identity, identityClaims);
        }
    }
    const byIdentity = new Map();
    const collisions = new Map();
    for (const [identity, paths] of claims){
        const sortedPaths = [
            ...paths
        ].sort();
        if (sortedPaths.length === 1 && sortedPaths[0]) {
            byIdentity.set(identity, sortedPaths[0]);
        } else if (sortedPaths.length > 1) {
            collisions.set(identity, sortedPaths);
        }
    }
    const buildMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    return {
        byIdentity,
        collisions,
        fileCount: files.length,
        parsedFileCount,
        identityCount: byIdentity.size,
        ignoredIdentityCount,
        buildMs
    };
}
function invalidateContactIndex(contactsDir) {
    const cacheKey = path.resolve(contactsDir);
    const entry = contactIndexCache.get(cacheKey);
    if (!entry) return;
    entry.version += 1;
    entry.value = undefined;
    entry.expiresAt = 0;
}
function ensureContactIndexWatcher(contactsDir, entry, cacheTtlMs) {
    if (cacheTtlMs === 0 || entry.watcher) return;
    try {
        const watcher = watch(contactsDir, {
            persistent: false
        }, ()=>{
            invalidateContactIndex(contactsDir);
        });
        watcher.on('error', ()=>{
            watcher.close();
            if (entry.watcher === watcher) entry.watcher = undefined;
            entry.version += 1;
            entry.value = undefined;
            entry.expiresAt = 0;
        });
        entry.watcher = watcher;
    } catch  {}
}
async function getContactIndex(contactsDir, options) {
    const cacheKey = path.resolve(contactsDir);
    const optionsKey = `${options.cacheTtlMs}:${options.maxFiles}:${options.scanConcurrency}`;
    let entry = contactIndexCache.get(cacheKey);
    if (!entry) {
        entry = {
            expiresAt: 0,
            version: 0,
            optionsKey
        };
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
        scanConcurrency: options.scanConcurrency
    });
    entry.loading = loading;
    try {
        const index = await loading;
        if (entry.version === versionAtStart && options.cacheTtlMs > 0) {
            entry.value = index;
            entry.expiresAt = Date.now() + options.cacheTtlMs;
        }
        return index;
    } finally{
        if (entry.loading === loading) entry.loading = undefined;
    }
}
function clearRuntimeCaches() {
    for (const entry of contactIndexCache.values())entry.watcher?.close();
    contactIndexCache.clear();
    fileMutationQueues.clear();
    loggedIssues.clear();
    openClawConfigCache = undefined;
}
async function resolveContactProfile(params) {
    const legacyPath = safeProfileFilePath(params.contactsDir, params.channel, params.id);
    const identity = normalizeIdentity(params.channel, params.id);
    if (!legacyPath || !identity) return {
        status: 'invalid'
    };
    const options = {
        enabled: params.options?.enabled !== false,
        cacheTtlMs: boundedInteger(params.options?.cacheTtlMs, DEFAULT_IDENTITY_CACHE_TTL_MS, 0, 3_600_000),
        maxFiles: boundedInteger(params.options?.maxFiles, DEFAULT_IDENTITY_MAX_FILES, 1, 100_000),
        scanConcurrency: boundedInteger(params.options?.scanConcurrency, DEFAULT_IDENTITY_SCAN_CONCURRENCY, 1, 16)
    };
    if (options.enabled) {
        try {
            const index = await getContactIndex(params.contactsDir, options);
            const collisions = index.collisions.get(identity);
            if (collisions) {
                const basenames = collisions.map((filePath)=>path.basename(filePath));
                logIssueOnce(`collision:${identity}:${basenames.join(',')}`, `[profile-injector] Identity collision for ${identity}; refusing to choose between ${basenames.join(', ')}`);
                return {
                    status: 'collision',
                    identity,
                    collisions
                };
            }
            const indexedPath = index.byIdentity.get(identity);
            if (indexedPath) return {
                status: 'resolved',
                identity,
                filePath: indexedPath
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logIssueOnce(`index-error:${params.contactsDir}:${message}`, `[profile-injector] Contact index unavailable; using exact-path fallback: ${message}`);
        }
    }
    if (await fileExists(legacyPath)) {
        return {
            status: 'legacy',
            identity,
            filePath: legacyPath
        };
    }
    return {
        status: 'missing',
        identity,
        filePath: legacyPath
    };
}
function yamlQuote(value) {
    return JSON.stringify(value);
}
function ensureContactIdentityList(content, identity) {
    const match = content.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/u);
    if (!match) {
        return `---\nid: ${yamlQuote(identity)}\nidentities:\n  - ${yamlQuote(identity)}\n---\n\n${content}`;
    }
    const frontmatter = match[2] ?? '';
    if (/^identities:\s*/mu.test(frontmatter)) return content;
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const idPattern = /^id:\s*.*$/mu;
    const newFrontmatter = idPattern.test(frontmatter) ? frontmatter.replace(idPattern, (line)=>`${line}${lineEnding}identities:${lineEnding}  - ${yamlQuote(identity)}`) : `id: ${yamlQuote(identity)}${lineEnding}identities:${lineEnding}  - ${yamlQuote(identity)}${lineEnding}${frontmatter}`;
    return `${match[1]}${newFrontmatter}${match[3]}${content.slice(match[0].length)}`;
}
function renderProfileTemplate(template, params) {
    const identity = `${params.channel}:${params.id}`;
    const displayName = params.displayName?.trim() || params.id;
    const date = params.date ?? new Date().toISOString().slice(0, 10);
    let rendered = template.replaceAll('<channel>:<user_id>', identity).replaceAll('<channel>:<group_id>', identity).replaceAll('<channel>', params.channel).replaceAll('<user_id>', params.id).replaceAll('<group_id>', params.id).replaceAll('<Name>', displayName).replaceAll('YYYY-MM-DD', date);
    if (params.kind === 'contact') rendered = ensureContactIdentityList(rendered, identity);
    return rendered;
}
async function createProfileIfMissing(params) {
    if (await fileExists(params.filePath)) return true;
    let template = '';
    if (await fileExists(params.templatePath)) {
        template = await fs.readFile(params.templatePath, 'utf-8');
    } else {
        const identity = `${params.channel}:${params.id}`;
        const heading = params.displayName?.trim() || params.id;
        template = params.kind === 'contact' ? `---\nid: ${yamlQuote(identity)}\nidentities:\n  - ${yamlQuote(identity)}\ncreated: "YYYY-MM-DD"\n---\n\n# Profile: <Name>\n\n*Auto-created by profile-injector.*\n` : `---\nid: ${yamlQuote(identity)}\ntype: "group"\ncreated: "YYYY-MM-DD"\nmembers: []\n---\n\n# Social memory for <Name>\n\n*Auto-created by profile-injector.*\n`;
        template = template.replaceAll('<Name>', heading);
    }
    const content = renderProfileTemplate(template, {
        channel: params.channel,
        id: params.id,
        kind: params.kind,
        displayName: params.displayName
    });
    await fs.mkdir(path.dirname(params.filePath), {
        recursive: true
    });
    try {
        await fs.writeFile(params.filePath, content, {
            encoding: 'utf-8',
            flag: 'wx'
        });
        if (params.contactsDir) invalidateContactIndex(params.contactsDir);
        console.log(`[profile-injector] Created missing profile: ${params.filePath}`);
        return true;
    } catch (error) {
        if (error?.code === 'EEXIST') return true;
        console.error(`[profile-injector] Failed to create profile ${params.filePath}:`, error);
        return false;
    }
}
async function writeFileAtomically(filePath, content) {
    const stat = await fs.stat(filePath);
    const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
    try {
        await fs.writeFile(tempPath, content, {
            encoding: 'utf-8',
            mode: stat.mode & 0o777,
            flag: 'wx'
        });
        await fs.rename(tempPath, filePath);
    } catch (error) {
        await fs.rm(tempPath, {
            force: true
        }).catch(()=>undefined);
        throw error;
    }
}
async function withFileMutationLock(filePath, task) {
    const key = path.resolve(filePath);
    const previous = fileMutationQueues.get(key) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve)=>{
        release = resolve;
    });
    const tail = previous.catch(()=>undefined).then(()=>gate);
    fileMutationQueues.set(key, tail);
    await previous.catch(()=>undefined);
    try {
        return await task();
    } finally{
        release();
        if (fileMutationQueues.get(key) === tail) fileMutationQueues.delete(key);
    }
}
function resolveConfigFilePath() {
    const homeDir = process.env.HOME || '/root';
    return process.env.OPENCLAW_CONFIG_PATH || path.join(homeDir, '.openclaw', 'openclaw.json');
}
async function readOpenClawConfigCached() {
    const filePath = resolveConfigFilePath();
    const now = Date.now();
    if (openClawConfigCache && openClawConfigCache.filePath === filePath && now < openClawConfigCache.expiresAt) {
        return openClawConfigCache.value;
    }
    try {
        const raw = await fs.readFile(filePath, 'utf-8');
        const value = JSON.parse(raw);
        openClawConfigCache = {
            filePath,
            value,
            expiresAt: now + CONFIG_CACHE_TTL_MS
        };
        return value;
    } catch  {
        return {};
    }
}
async function resolveRuntime(cfg, explicitWorkspaceDir) {
    const effectiveCfg = cfg ?? await readOpenClawConfigCached();
    const homeDir = process.env.HOME || '/root';
    const workspaceDir = explicitWorkspaceDir || effectiveCfg?.workspace?.dir || effectiveCfg?.agents?.defaults?.workspace || path.join(homeDir, '.openclaw', 'workspace');
    const hookConfig = effectiveCfg?.hooks?.internal?.entries?.['profile-injector'] || {};
    return {
        cfg: effectiveCfg,
        workspaceDir,
        hookConfig
    };
}
function templatePath(workspaceDir, hookConfig, kind) {
    const configured = kind === 'contact' ? hookConfig?.contactTemplate : hookConfig?.channelTemplate;
    return resolveWorkspacePath(workspaceDir, configured, kind === 'contact' ? DEFAULT_CONTACT_TEMPLATE : DEFAULT_CHANNEL_TEMPLATE);
}
function memberBootstrapName(memberId) {
    const safeId = memberId.replace(/[^a-zA-Z0-9_.+@-]/gu, '_').slice(0, 100);
    return `MEMBER_PROFILE_${safeId}.md`;
}
async function handleBootstrap(event) {
    const context = event.context || {};
    const { sessionKey, workspaceDir, bootstrapFiles, cfg } = context;
    if (!sessionKey || !workspaceDir || !Array.isArray(bootstrapFiles)) return;
    const address = parseSessionAddress(sessionKey);
    if (!address) return;
    const hookConfig = cfg?.hooks?.internal?.entries?.['profile-injector'] || {};
    const createOnMiss = hookConfig.createOnMiss === true;
    const identityOptions = identityResolutionOptions(hookConfig);
    const directories = resolveProfileDirectories(workspaceDir, hookConfig);
    const filesToInject = [];
    if (address.type === 'direct') {
        const resolution = await resolveContactProfile({
            contactsDir: directories.contactsDir,
            channel: address.channel,
            id: address.id,
            options: identityOptions
        });
        if (resolution.status === 'collision' || resolution.status === 'invalid') return;
        if (resolution.status === 'missing' && createOnMiss && resolution.filePath) {
            await createProfileIfMissing({
                filePath: resolution.filePath,
                templatePath: templatePath(workspaceDir, hookConfig, 'contact'),
                workspaceDir,
                contactsDir: directories.contactsDir,
                channel: address.channel,
                id: address.id,
                kind: 'contact'
            });
        }
        if (resolution.filePath && await fileExists(resolution.filePath)) {
            filesToInject.push({
                name: 'CONTACT_PROFILE.md',
                filePath: resolution.filePath,
                depth: 'full',
                kind: 'contact'
            });
        }
    } else {
        const groupFilePath = safeProfileFilePath(directories.groupsDir, address.channel, address.id);
        if (!groupFilePath) return;
        if (!await fileExists(groupFilePath) && createOnMiss) {
            await createProfileIfMissing({
                filePath: groupFilePath,
                templatePath: templatePath(workspaceDir, hookConfig, 'group'),
                workspaceDir,
                channel: address.channel,
                id: address.id,
                kind: 'group'
            });
        }
        if (await fileExists(groupFilePath)) {
            filesToInject.push({
                name: 'CHANNEL_PROFILE.md',
                filePath: groupFilePath,
                depth: 'full',
                kind: 'channel'
            });
            const groupInclusion = hookConfig.groupInclusion || {};
            if (groupInclusion.enabled === true) {
                try {
                    const groupContent = await fs.readFile(groupFilePath, 'utf-8');
                    const memberIds = getMemberIds(groupContent);
                    const maxContacts = boundedInteger(groupInclusion.maxContacts, DEFAULT_GROUP_MAX_CONTACTS, 0, 100);
                    const seenCanonicalPaths = new Set();
                    for (const memberId of memberIds.slice(0, maxContacts)){
                        const resolution = await resolveContactProfile({
                            contactsDir: directories.contactsDir,
                            channel: address.channel,
                            id: memberId,
                            options: identityOptions
                        });
                        if (resolution.status === 'collision' || resolution.status === 'invalid') continue;
                        if (resolution.status === 'missing' && createOnMiss && resolution.filePath) {
                            await createProfileIfMissing({
                                filePath: resolution.filePath,
                                templatePath: templatePath(workspaceDir, hookConfig, 'contact'),
                                workspaceDir,
                                contactsDir: directories.contactsDir,
                                channel: address.channel,
                                id: memberId,
                                kind: 'contact'
                            });
                        }
                        if (resolution.filePath && !seenCanonicalPaths.has(resolution.filePath) && await fileExists(resolution.filePath)) {
                            seenCanonicalPaths.add(resolution.filePath);
                            filesToInject.push({
                                name: memberBootstrapName(memberId),
                                filePath: resolution.filePath,
                                depth: profileDepth(groupInclusion.profileDepth),
                                kind: 'member'
                            });
                        }
                    }
                } catch (error) {
                    console.error('[profile-injector] Group member loading failed:', error);
                }
            }
        }
    }
    const maxMemberChars = boundedInteger(hookConfig?.groupInclusion?.maxTotalChars, DEFAULT_GROUP_MAX_TOTAL_CHARS, 0, 1_000_000);
    let injectedMemberChars = 0;
    for (const item of filesToInject){
        if (bootstrapFiles.some((file)=>file?.name === item.name || path.resolve(file?.path ?? '') === item.filePath)) {
            continue;
        }
        if (item.kind === 'member' && injectedMemberChars >= maxMemberChars) continue;
        try {
            let content = await fs.readFile(item.filePath, 'utf-8');
            const remainingMemberChars = item.kind === 'member' ? maxMemberChars - injectedMemberChars : Number.POSITIVE_INFINITY;
            content = capContent(content, item.depth, remainingMemberChars);
            if (item.kind === 'member') injectedMemberChars += content.length;
            bootstrapFiles.push({
                name: item.name,
                path: item.filePath,
                content,
                missing: false
            });
        } catch (error) {
            console.error(`[profile-injector] Failed to inject ${item.filePath}:`, error);
        }
    }
}
async function handleRosterEvent(event, senderId, metadata = {}) {
    const sessionKey = event.sessionKey;
    if (!sessionKey || senderId === undefined || senderId === null) return;
    const address = parseSessionAddress(sessionKey);
    if (!address || address.type !== 'group' && address.type !== 'channel') return;
    const sender = String(senderId).trim();
    if (!isSafeProfileId(sender)) return;
    const context = event.context || {};
    const runtime = await resolveRuntime(context.cfg, context.workspaceDir);
    const hookConfig = runtime.hookConfig;
    if (hookConfig.autoRoster === false) return;
    const directories = resolveProfileDirectories(runtime.workspaceDir, hookConfig);
    const groupFilePath = safeProfileFilePath(directories.groupsDir, address.channel, address.id);
    if (!groupFilePath || !await fileExists(groupFilePath)) return;
    try {
        const changed = await withFileMutationLock(groupFilePath, async ()=>{
            const groupContent = await fs.readFile(groupFilePath, 'utf-8');
            const updated = addMemberToFrontmatter(groupContent, sender);
            if (!updated) return false;
            await writeFileAtomically(groupFilePath, updated);
            return true;
        });
        if (changed) {
            console.log(`[profile-injector] Auto-rostered ${sender} into ${path.basename(groupFilePath)}`);
        }
        if (hookConfig.createOnMiss === true) {
            const identityOptions = identityResolutionOptions(hookConfig);
            const resolution = await resolveContactProfile({
                contactsDir: directories.contactsDir,
                channel: address.channel,
                id: sender,
                options: identityOptions
            });
            if (resolution.status === 'missing' && resolution.filePath) {
                const senderName = metadata?.senderName || metadata?.sender_name || metadata?.displayName || metadata?.display_name || '';
                await createProfileIfMissing({
                    filePath: resolution.filePath,
                    templatePath: templatePath(runtime.workspaceDir, hookConfig, 'contact'),
                    workspaceDir: runtime.workspaceDir,
                    contactsDir: directories.contactsDir,
                    channel: address.channel,
                    id: sender,
                    kind: 'contact',
                    displayName: senderName
                });
            }
        }
    } catch (error) {
        console.error('[profile-injector] Auto-roster failed:', error);
    }
}
async function handleMessageReceived(event) {
    const metadata = event.context?.metadata || {};
    const senderId = metadata.senderId ?? metadata.sender_id;
    await handleRosterEvent(event, senderId, metadata);
}
async function handleCommandNew(event) {
    await handleRosterEvent(event, event.context?.senderId, event.context || {});
}
const handler = async (event)=>{
    if (event.type === 'agent' && event.action === 'bootstrap') {
        return handleBootstrap(event);
    }
    if (event.type === 'message' && event.action === 'received') {
        return handleMessageReceived(event);
    }
    if (event.type === 'command' && event.action === 'new') {
        return handleCommandNew(event);
    }
};
export { addMemberToFrontmatter, buildContactIndex, capContent, clearRuntimeCaches, extractContactIdentities, getMemberIds, invalidateContactIndex, normalizeIdentity, parseSessionAddress, renderProfileTemplate, resolveContactProfile };
export default handler;
