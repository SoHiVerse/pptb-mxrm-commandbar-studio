#!/usr/bin/env node
/**
 * Package a relative Vite on-prem build as a Dynamics 365 CE v9.1 unmanaged
 * solution. Every WebResource/FileName entry is a real ZIP binary part; UUIDv5
 * identities depend on the logical web-resource name, never on build contents.
 *
 * This is a local build/package operation; it never connects to CRM, imports a
 * solution, publishes customizations or acquires user credentials.
 */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, unzipSync, zipSync } from 'fflate';
import ts from 'typescript';

const WEB_RESOURCE_TYPES = Object.freeze({
  '.htm': 1,
  '.html': 1,
  '.css': 2,
  '.js': 3,
  '.xml': 4,
  '.png': 5,
  '.jpg': 6,
  '.gif': 7,
  '.xap': 8,
  '.xsl': 9,
  '.xslt': 9,
  '.ico': 10,
  '.svg': 11,
  '.resx': 12,
});

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_DIR = 'dist-onprem';
const OUTPUT_DIR = 'dist-onprem-package';
// ZIP stores MS-DOS *local* calendar fields, not an instant in UTC. The UTC
// epoch would be 1979-12-31 in western zones (fflate rejects pre-1980 dates)
// and different byte values elsewhere. Build the same local wall time in every
// process regardless of TZ, including deterministic cross-machine archives.
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0, 0);

// A fixed, app-specific UUID namespace for RFC 4122 UUIDv5 (SHA-1).
const RESOURCE_NAMESPACE = '44e7d2c8-5f62-4a9c-9089-62f23c84b8fd';

const DEFAULTS = Object.freeze({
  solutionUniqueName: 'CommandBarStudioNative',
  solutionDisplayName: 'Command Bar Studio Native',
  publisherUniqueName: 'mxrmcommandbarstudio',
  publisherDisplayName: 'Command Bar Studio',
  publisherPrefix: 'mxrm',
  publisherOptionValuePrefix: 10000,
  version: '1.0.0.0',
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  inputDir: DEFAULT_DIR,
  outputZip: path.join(OUTPUT_DIR, 'CommandBarStudioNative_unmanaged.zip'),
  manifestPath: path.join(OUTPUT_DIR, 'asset-manifest.json'),
  dryRun: false,
});

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertValid(value, expression, label) {
  if (typeof value !== 'string' || !expression.test(value)) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)}`);
  }
}

function validateIdentity(options) {
  assertValid(options.publisherPrefix, /^[a-z][a-z0-9]{1,7}$/, 'publisher prefix (2–8 lowercase letters/digits; start with a letter)');
  if (options.publisherPrefix.startsWith('mscrm')) {
    throw new Error('Invalid publisher prefix: reserved mscrm prefix.');
  }
  assertValid(options.solutionUniqueName, /^[A-Za-z][A-Za-z0-9_]{0,99}$/, 'solution unique name');
  assertValid(options.publisherUniqueName, /^[A-Za-z][A-Za-z0-9_]{0,99}$/, 'publisher unique name');
  for (const [label, value] of [['solution display name', options.solutionDisplayName], ['publisher display name', options.publisherDisplayName]]) {
    if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\x00-\x1f]/.test(value)) {
      throw new Error(`Invalid ${label}: must contain 1–100 printable characters.`);
    }
  }
  assertValid(options.version, /^\d{1,5}\.\d{1,5}\.\d{1,5}\.\d{1,5}$/, 'solution version (four dot-separated numbers)');
  if (options.version.split('.').some((number) => Number(number) > 65535)) {
    throw new Error('Invalid solution version: components must be between 0 and 65535.');
  }
  if (!Number.isInteger(options.publisherOptionValuePrefix) || options.publisherOptionValuePrefix < 10000 || options.publisherOptionValuePrefix > 99999) {
    throw new Error('Invalid publisher option value prefix: expected integer 10000–99999.');
  }
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes <= 0) {
    throw new Error('Invalid maximum web-resource size: --max-file-bytes must be a positive integer.');
  }
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** Stable RFC 4122 version-5 component identity, keyed solely by logical name. */
export function stableWebResourceGuid(logicalName) {
  if (typeof logicalName !== 'string' || !logicalName || /[^A-Za-z0-9_./-]/.test(logicalName)) {
    throw new Error(`Invalid web resource logical name: ${JSON.stringify(logicalName)}`);
  }
  const namespaceBytes = Buffer.from(RESOURCE_NAMESPACE.replaceAll('-', ''), 'hex');
  const hash = createHash('sha1').update(namespaceBytes).update(Buffer.from(logicalName.toLowerCase(), 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Validate *all* relative build names before deriving CRM names or touching ZIP. */
export function validateAssetPaths(sources, publisherPrefix = DEFAULTS.publisherPrefix) {
  const seen = new Set();
  const output = [];
  for (const source of sources) {
    if (typeof source !== 'string' || source.length > 220 || !/^[A-Za-z0-9_./-]+$/.test(source)) {
      throw new Error(`Invalid relative asset path: ${JSON.stringify(source)}`);
    }
    const segments = source.split('/');
    if (segments.some((part) => !part || part === '.' || part === '..' || part.startsWith('.')) ||
      source.startsWith('/') || source.endsWith('/')) {
      throw new Error(`Invalid asset path or traversal: ${source}`);
    }
    const extension = path.posix.extname(source).toLowerCase();
    const type = WEB_RESOURCE_TYPES[extension];
    if (!type) {
      throw new Error(`Unsupported CRM web resource file extension ${extension || '(none)'}: ${source}`);
    }
    const logicalName = `${publisherPrefix}_/commandbarstudio/${source}`;
    if (logicalName.length > 240) {
      throw new Error(`CRM web resource name exceeds 240 characters: ${logicalName}`);
    }
    const folded = logicalName.toLowerCase();
    if (seen.has(folded)) {
      throw new Error(`Case-insensitive web resource name collision: ${logicalName}`);
    }
    seen.add(folded);
    output.push({ source, logicalName, type });
  }
  return output;
}

async function readBuildFiles(inputDir) {
  const rootInfo = await lstat(inputDir);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error(`Build input must be a real directory: ${inputDir}`);
  }
  const resources = [];
  async function walk(directory, relPrefix = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => compareAscii(a.name, b.name));
    for (const entry of entries) {
      const source = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`Build contains a symbolic link (disallowed): ${source}`);
      }
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new Error(`Invalid hidden build directory: ${source}`);
        await walk(path.join(directory, entry.name), source);
      } else if (entry.isFile()) {
        resources.push({ source, absolutePath: path.join(directory, entry.name) });
      } else {
        throw new Error(`Unsupported build file type: ${source}`);
      }
    }
  }
  await walk(inputDir);
  return resources;
}

/** Read only syntactic, literal JS dependencies; grammar strings are not code. */
function javascriptReferences(source, text) {
  const file = ts.createSourceFile(source, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (file.parseDiagnostics.length) {
    const error = file.parseDiagnostics[0];
    const at = file.getLineAndCharacterOfPosition(error.start ?? 0);
    throw new Error(`Cannot parse JavaScript asset ${source}:${at.line + 1}:${at.character + 1}; refusing an incomplete reference check.`);
  }

  const found = [];
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  const collect = (node) => {
    const value = literal(node);
    if (value === '') throw new Error(`Empty JavaScript asset reference in ${source}.`);
    if (value !== null) found.push(value);
  };
  const isImportMetaUrl = (node) => ts.isPropertyAccessExpression(node) && node.name.text === 'url' &&
    ts.isMetaProperty(node.expression) && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
    node.expression.name.text === 'meta';

  const visit = (node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier) collect(node.moduleSpecifier);
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        collect(node.arguments[0]);
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'importScripts') {
        node.arguments.forEach(collect);
      } else if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'importScripts' &&
          ts.isIdentifier(node.expression.expression) && ['self', 'globalThis'].includes(node.expression.expression.text)) {
        node.arguments.forEach(collect);
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'URL' && node.arguments?.length >= 2 && isImportMetaUrl(node.arguments[1])) {
        collect(node.arguments[0]);
      } else if (['Worker', 'SharedWorker'].includes(node.expression.text)) {
        // A nested new URL(..., import.meta.url) is found by walking children.
        collect(node.arguments?.[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function staticReferences(source, text) {
  const found = [];
  if (/\.html?$/i.test(source)) {
    // Only static asset-bearing markup is scanned; ordinary external <a> links
    // within the application's runtime UI are not dependencies.
    for (const tag of text.matchAll(/<(?:script|link|img|source)\b[^>]*>/gi)) {
      const attr = /(?:^|\s)(?:src|href|srcset)\s*=\s*(['"])(.*?)\1/i.exec(tag[0]);
      if (attr) found.push(attr[2]);
    }
  }
  if (/\.css$/i.test(source)) {
    for (const match of text.matchAll(/\burl\(\s*(['"]?)([^\)'"\s]+)\1\s*\)/gi)) found.push(match[2]);
    for (const match of text.matchAll(/@import\s*(['"])([^'"]+)\1/gi)) found.push(match[2]);
  }
  if (/\.js$/i.test(source)) {
    found.push(...javascriptReferences(source, text));
  }
  return found;
}

function assertReferences(resources, contentByName, entryLogicalName) {
  const names = new Set(resources.map((resource) => resource.source));
  const contextPath = `${'../'.repeat(entryLogicalName.split('/').length - 1)}ClientGlobalContext.js.aspx`;
  const html = contentByName.get('onprem.html')?.toString('utf8');
  if (!html) throw new Error('Missing required native HTML entry: onprem.html');
  // HTML must synchronously load CRM global context before the module entry.
  const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map((match) => match[0]);
  const contextIndex = scripts.findIndex((tag) => new RegExp(`(?:^|\\s)src\\s*=\\s*(['"])${contextPath.replaceAll('.', '\\.')}\\1`).test(tag));
  const moduleIndex = scripts.findIndex((tag) => /(?:^|\s)type\s*=\s*['"]module['"]/.test(tag));
  if (contextIndex < 0 || moduleIndex < 0 || contextIndex >= moduleIndex || /\b(?:async|defer)\b/i.test(scripts[contextIndex])) {
    throw new Error(`Native HTML must synchronously load ${contextPath} before its module script.`);
  }

  for (const { source, type } of resources) {
    if (![1, 2, 3].includes(type)) continue;
    const text = contentByName.get(source).toString('utf8');
    for (const raw of staticReferences(source, text)) {
      if (!raw || raw.startsWith('#') || /^data:|^blob:/i.test(raw)) continue;
      if (source === 'onprem.html' && raw === contextPath) continue;
      if (/^(?:[a-z][a-z\d+.-]*:|\/|\\)/i.test(raw)) {
        throw new Error(`Absolute or external asset reference in ${source}: ${raw}`);
      }
      const cleaned = raw.split(/[?#]/, 1)[0];
      if (!cleaned) continue;
      const destination = path.posix.normalize(path.posix.join(path.posix.dirname(source), cleaned));
      if (destination === '..' || destination.startsWith('../') || !names.has(destination)) {
        throw new Error(`Missing or escaping asset reference from ${source}: ${raw} (resolved: ${destination})`);
      }
    }
  }
  return contextPath;
}

function buildSolutionXml(options, resources) {
  const rootComponents = resources.map((resource) =>
    `      <RootComponent type="61" schemaName="${escapeXml(resource.logicalName)}" behavior="0" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.1.0.0" SolutionPackageVersion="9.1" languagecode="1033" generatedBy="OnPremise" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${escapeXml(options.solutionUniqueName)}</UniqueName>
    <LocalizedNames><LocalizedName description="${escapeXml(options.solutionDisplayName)}" languagecode="1033" /></LocalizedNames>
    <Descriptions />
    <Version>${escapeXml(options.version)}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${escapeXml(options.publisherUniqueName)}</UniqueName>
      <LocalizedNames><LocalizedName description="${escapeXml(options.publisherDisplayName)}" languagecode="1033" /></LocalizedNames>
      <Descriptions />
      <EMailAddress xsi:nil="true" />
      <SupportingWebsiteUrl xsi:nil="true" />
      <CustomizationPrefix>${escapeXml(options.publisherPrefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${options.publisherOptionValuePrefix}</CustomizationOptionValuePrefix>
      <Addresses />
    </Publisher>
    <RootComponents>
${rootComponents}
    </RootComponents>
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

function buildCustomizationsXml(options, resources) {
  const webResources = resources.map((resource) => `    <WebResource>
      <WebResourceId>{${resource.componentId}}</WebResourceId>
      <Name>${escapeXml(resource.logicalName)}</Name>
      <DisplayName>${escapeXml(`Command Bar Studio / ${resource.source}`)}</DisplayName>
      <WebResourceType>${resource.type}</WebResourceType>
      <IntroducedVersion>${escapeXml(options.version)}</IntroducedVersion>
      <IsEnabledForMobileClient>0</IsEnabledForMobileClient>
      <IsAvailableForMobileOffline>0</IsAvailableForMobileOffline>
      <IsCustomizable>1</IsCustomizable>
      <CanBeDeleted>1</CanBeDeleted>
      <IsHidden>0</IsHidden>
      <FileName>/${escapeXml(resource.zipPath)}</FileName>
    </WebResource>`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <WebResources>
${webResources}
  </WebResources>
  <CustomControls />
  <EntityDataProviders />
  <Languages><Language>1033</Language></Languages>
</ImportExportXml>
`;
}

function buildContentTypesXml(resources) {
  // CRM XML solution exports conventionally mark component content as
  // application/octet-stream; web-resource ZIP filenames end with GUIDs and
  // thus have no file extension, requiring per-part OPC overrides.
  const overrides = resources.map((resource) =>
    `  <Override PartName="/${escapeXml(resource.zipPath)}" ContentType="application/octet-stream" />`).join('\n');
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/octet-stream" />
${overrides}
</Types>
`;
}

function validateGeneratedZip(zipBytes, resources) {
  // Internal package integrity validation supplements tests inspecting the
  // actual zip, rather than just asserting a JSON manifest was generated.
  const entries = unzipSync(zipBytes);
  const names = Object.keys(entries).sort(compareAscii);
  const expected = ['solution.xml', 'customizations.xml', '[Content_Types].xml', ...resources.map((r) => r.zipPath)].sort(compareAscii);
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error('Solution ZIP internal file mapping mismatch.');
  const xml = Buffer.from(entries['customizations.xml']).toString('utf8');
  const solution = Buffer.from(entries['solution.xml']).toString('utf8');
  const types = Buffer.from(entries['[Content_Types].xml']).toString('utf8');
  for (const resource of resources) {
    if (!xml.includes(`<FileName>/${escapeXml(resource.zipPath)}</FileName>`) ||
      !xml.includes(`<WebResourceId>{${resource.componentId}}</WebResourceId>`) ||
      !solution.includes(`schemaName="${escapeXml(resource.logicalName)}"`) ||
      !types.includes(`PartName="/${escapeXml(resource.zipPath)}"`)) {
      throw new Error(`Solution ZIP XML does not reference ${resource.logicalName} consistently.`);
    }
  }
}

/** Build ZIP + adjacent JSON manifest. In dry-run mode return report only. */
export async function packageNativeSolution(provided = {}) {
  const options = { ...DEFAULTS, ...provided };
  validateIdentity(options);
  const inputDir = path.resolve(options.inputDir);
  const outputZip = path.resolve(options.outputZip);
  const manifestPath = path.resolve(options.manifestPath);
  if (outputZip === manifestPath || !outputZip.toLowerCase().endsWith('.zip') || !manifestPath.toLowerCase().endsWith('.json')) {
    throw new Error('Output ZIP and manifest JSON must be distinct .zip and .json paths.');
  }
  const relativeOut = path.relative(inputDir, outputZip);
  const relativeManifest = path.relative(inputDir, manifestPath);
  if ((relativeOut && !relativeOut.startsWith('..') && !path.isAbsolute(relativeOut)) ||
      (relativeManifest && !relativeManifest.startsWith('..') && !path.isAbsolute(relativeManifest))) {
    throw new Error('Write output and manifest outside dist-onprem to prevent re-packaging build artifacts.');
  }

  const found = await readBuildFiles(inputDir);
  const assetDefinitions = validateAssetPaths(found.map((file) => file.source), options.publisherPrefix);
  const contentByName = new Map();
  const resources = [];
  for (const definition of assetDefinitions) {
    const file = found.find((item) => item.source === definition.source);
    const content = await readFile(file.absolutePath);
    if (content.length > options.maxFileBytes) {
      throw new Error(`Web resource ${definition.source} exceeds maximum size ${options.maxFileBytes} bytes (actual: ${content.length}).`);
    }
    const componentId = stableWebResourceGuid(definition.logicalName);
    // CRM 9.1's real exporter flattens slash/dot characters in binary file
    // names, then appends the resource GUID in uppercase (without braces).
    // The logical <Name> and RootComponent schemaName keep their separators.
    const zipPath = `WebResources/${definition.logicalName.replace(/[/.]/g, '')}${componentId.toUpperCase()}`;
    resources.push({
      ...definition,
      componentId,
      zipPath,
      bytes: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
    contentByName.set(definition.source, content);
  }

  const entryLogicalName = `${options.publisherPrefix}_/commandbarstudio/onprem.html`;
  const contextScript = assertReferences(resources, contentByName, entryLogicalName);
  const totalBytes = resources.reduce((sum, resource) => sum + resource.bytes, 0);
  const largestResource = resources.reduce((largest, resource) => !largest || resource.bytes > largest.bytes ? resource : largest, null);
  const manifest = {
    format: 'dynamics365-ce-onprem-v9.1-webresources-v1',
    solution: {
      uniqueName: options.solutionUniqueName,
      displayName: options.solutionDisplayName,
      version: options.version,
      managed: false,
      publisher: {
        uniqueName: options.publisherUniqueName,
        displayName: options.publisherDisplayName,
        prefix: options.publisherPrefix,
        optionValuePrefix: options.publisherOptionValuePrefix,
      },
    },
    entry: entryLogicalName,
    contextScript,
    maximumFileBytes: options.maxFileBytes,
    totalBytes,
    largestResource: largestResource && { source: largestResource.source, bytes: largestResource.bytes },
    resources,
  };
  const report = { ...manifest, dryRun: Boolean(options.dryRun) };
  if (options.dryRun) return report;

  const zipParts = {
    '[Content_Types].xml': [strToU8(buildContentTypesXml(resources)), { mtime: ZIP_MTIME }],
    'customizations.xml': [strToU8(buildCustomizationsXml(options, resources)), { mtime: ZIP_MTIME }],
    'solution.xml': [strToU8(buildSolutionXml(options, resources)), { mtime: ZIP_MTIME }],
  };
  for (const resource of resources) {
    zipParts[resource.zipPath] = [contentByName.get(resource.source), { mtime: ZIP_MTIME }];
  }
  const bytes = zipSync(zipParts, { level: 6, mtime: ZIP_MTIME });
  validateGeneratedZip(bytes, resources);
  await mkdir(path.dirname(outputZip), { recursive: true });
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(outputZip, bytes);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return report;
}

function parseArguments(args) {
  const fields = new Map([
    ['--input', 'inputDir'], ['--output', 'outputZip'], ['--manifest', 'manifestPath'],
    ['--solution-unique-name', 'solutionUniqueName'], ['--solution-display-name', 'solutionDisplayName'],
    ['--publisher-unique-name', 'publisherUniqueName'], ['--publisher-display-name', 'publisherDisplayName'],
    ['--publisher-prefix', 'publisherPrefix'], ['--option-value-prefix', 'publisherOptionValuePrefix'],
    ['--version', 'version'], ['--max-file-bytes', 'maxFileBytes'],
  ]);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      options.dryRun = true;
    } else if (args[i] === '--help') {
      return null;
    } else {
      const key = fields.get(args[i]);
      if (!key || i + 1 >= args.length || args[i + 1].startsWith('--')) {
        throw new Error(`Unknown or incomplete CLI option: ${args[i]}`);
      }
      const raw = args[++i];
      if (key === 'publisherOptionValuePrefix' || key === 'maxFileBytes') {
        if (!/^\d+$/.test(raw)) throw new Error(`${args[i - 1]} must be a positive decimal integer.`);
        options[key] = Number(raw);
      } else {
        options[key] = raw;
      }
    }
  }
  return options;
}

function printReport(report) {
  const lines = [
    `Dynamics 365 CE v9.1 unmanaged solution: ${report.solution.uniqueName} v${report.solution.version}`,
    `Publisher: ${report.solution.publisher.uniqueName} (${report.solution.publisher.prefix})`,
    `Entry: ${report.entry} (CRM context: ${report.contextScript})`,
    `Resources (${report.resources.length}; maximum ${report.maximumFileBytes} bytes each):`,
    ...report.resources.map((r) => `  ${r.logicalName} [type ${r.type}, ${r.bytes} bytes, id ${r.componentId}]`),
    `Total asset bytes: ${report.totalBytes}`,
    `Largest resource: ${report.largestResource?.source ?? 'none'} (${report.largestResource?.bytes ?? 0} bytes)`,
    report.dryRun ? 'Dry run completed: no files written.' : 'ZIP and asset manifest written.',
  ];
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const usage = `Usage: node scripts/package-onprem.mjs [options]\n\n` +
    `  --input PATH                    (default: ${DEFAULT_DIR})\n` +
    `  --output PATH                   (default: ${DEFAULTS.outputZip})\n` +
    `  --manifest PATH                 (default: ${DEFAULTS.manifestPath})\n` +
    `  --publisher-prefix PREFIX       (default: mxrm)\n` +
    `  --publisher-unique-name NAME\n  --publisher-display-name NAME\n` +
    `  --option-value-prefix 10000..99999\n` +
    `  --solution-unique-name NAME\n  --solution-display-name NAME\n` +
    `  --version N.N.N.N              (default: 1.0.0.0)\n` +
    `  --max-file-bytes N             (default: ${DEFAULT_MAX_FILE_BYTES})\n` +
    `  --dry-run                      (validate/report; do not write)\n` +
    `  --help\n`;
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options === null) process.stdout.write(usage);
    else process.stdout.write(printReport(await packageNativeSolution(options)));
  } catch (error) {
    process.stderr.write(`On-prem solution packaging failed: ${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    process.exitCode = 1;
  }
}
