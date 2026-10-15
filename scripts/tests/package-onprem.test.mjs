import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strFromU8, unzipSync } from 'fflate';
import {
  packageNativeSolution,
  stableWebResourceGuid,
  validateAssetPaths,
} from '../package-onprem.mjs';

const scriptPath = fileURLToPath(new URL('../package-onprem.mjs', import.meta.url));
const contextSrc = '../../ClientGlobalContext.js.aspx';
const observedV91Format = JSON.parse(await readFile(new URL('./fixtures/v91-webresource-format.json', import.meta.url), 'utf8'));

const fixtureFiles = {
  'onprem.html': `<!doctype html><html><head><link rel="stylesheet" href="./assets/app.102.css"></head><body><script src="${contextSrc}"></script><script type="module" src="./assets/app.102.js"></script></body></html>`,
  'assets/app.102.js': 'import("./lazy.103.js"); console.log("loaded");',
  'assets/lazy.103.js': 'export default 23;',
  'assets/app.102.css': 'div { background-image: url(data:image/png;base64,aGVsbG8=) }',
  'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
};

function packageOptions(dir) {
  return {
    inputDir: path.join(dir, 'dist-onprem'),
    outputZip: path.join(dir, 'package', 'Native_unmanaged.zip'),
    manifestPath: path.join(dir, 'package', 'asset-manifest.json'),
    solutionUniqueName: 'CommandBarStudioNative',
    solutionDisplayName: 'Command Bar Studio Native',
    publisherUniqueName: 'mxrmcommandbarstudio',
    publisherDisplayName: 'Command Bar Studio',
    publisherPrefix: 'mxrm',
    publisherOptionValuePrefix: 78123,
    version: '1.2.3.4',
    maxFileBytes: 5 * 1024 * 1024,
  };
}

async function withFixture(callback, overrides = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'onprem-package-'));
  const inputDir = path.join(dir, 'dist-onprem');
  await mkdir(inputDir);
  try {
    for (const [name, contents] of Object.entries({ ...fixtureFiles, ...overrides })) {
      if (contents === null) continue;
      const filename = path.join(inputDir, ...name.split('/'));
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, contents);
    }
    return await callback(packageOptions(dir), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function zipText(zip, name) {
  assert.ok(zip[name], `Expected solution ZIP part ${name}`);
  return strFromU8(zip[name]);
}

test('produces a real CRM 9.1 unmanaged solution ZIP with every binary webresource referenced', async () => {
  await withFixture(async (options) => {
    const result = await packageNativeSolution(options);
    const zip = unzipSync(await readFile(options.outputZip));
    const manifest = JSON.parse(await readFile(options.manifestPath, 'utf8'));
    const solution = zipText(zip, 'solution.xml');
    const customizations = zipText(zip, 'customizations.xml');
    const contentTypes = zipText(zip, '[Content_Types].xml');

    assert.equal(result.resources.length, 5);
    assert.equal(manifest.resources.length, 5);
    assert.match(contentTypes, /<Types xmlns="http:\/\/schemas\.openxmlformats\.org\/package\/2006\/content-types">/);
    assert.match(solution, /<ImportExportXml[^>]*SolutionPackageVersion="9\.1"/);
	assert.match(solution, /<ImportExportXml[^>]*generatedBy="OnPremise"/);
	assert.doesNotMatch(solution, /generatedBy="CrmLive"/);
    assert.match(solution, /<Managed>0<\/Managed>/);
    assert.match(solution, /<UniqueName>CommandBarStudioNative<\/UniqueName>/);
    assert.match(solution, /<CustomizationOptionValuePrefix>78123<\/CustomizationOptionValuePrefix>/);
    assert.match(solution, /<RootComponent type="61" schemaName="mxrm_\/commandbarstudio\/onprem\.html" behavior="0"\s*\/>/);
    assert.match(customizations, /<WebResources>/);
    assert.match(customizations, /<WebResourceType>1<\/WebResourceType>/);
    assert.match(customizations, /<WebResourceType>2<\/WebResourceType>/);
    assert.match(customizations, /<WebResourceType>3<\/WebResourceType>/);
    assert.match(customizations, /<WebResourceType>11<\/WebResourceType>/);
    assert.doesNotMatch(customizations, /<LanguageCode>/, 'v9.1 exported WebResource definition omits LanguageCode');
    assert.match(customizations, /<CustomControls\s*\/>/);
    assert.match(customizations, /<EntityDataProviders\s*\/>/);
    assert.ok(!customizations.includes('<Content>'), 'binary file content must live in a ZIP part');

    for (const resource of manifest.resources) {
      assert.ok(zip[resource.zipPath], `Missing binary ZIP part ${resource.zipPath}`);
      assert.match(customizations, new RegExp(`<Name>${resource.logicalName.replaceAll('.', '\\.')}<\\/Name>`));
      assert.ok(customizations.includes(`<WebResourceId>{${resource.componentId}}</WebResourceId>`));
      assert.ok(customizations.includes(`<FileName>/${resource.zipPath}</FileName>`));
      assert.ok(solution.includes(`schemaName="${resource.logicalName}"`));
      assert.equal(resource.zipPath,
        `WebResources/${resource.logicalName.replace(/[/.]/g, '')}${resource.componentId.toUpperCase()}`,
        'Dynamics 365 9.1 export flattens slashes and dots in the ZIP payload name');
      assert.ok(contentTypes.includes(`PartName="/${resource.zipPath}" ContentType="application/octet-stream"`));
      const original = await readFile(path.join(options.inputDir, ...resource.source.split('/')));
      assert.deepEqual(Buffer.from(zip[resource.zipPath]), original, `Wrong resource bytes: ${resource.source}`);
      assert.equal(resource.componentId, stableWebResourceGuid(resource.logicalName));
    }
    assert.ok(!Object.keys(zip).some((name) => name.includes('asset-manifest.json')));
  });
});

test('packaging repeats byte for byte and entry GUID remains stable across changed builds', async () => {
  await withFixture(async (options, dir) => {
    const first = await packageNativeSolution(options);
    const firstZip = await readFile(options.outputZip);
    const firstManifest = await readFile(options.manifestPath);
    const duplicate = { ...options, outputZip: path.join(dir, 'another.zip'), manifestPath: path.join(dir, 'another.json') };
    await packageNativeSolution(duplicate);
    assert.deepEqual(await readFile(duplicate.outputZip), firstZip);
    assert.deepEqual(await readFile(duplicate.manifestPath), firstManifest);

    const entryId = first.resources.find((r) => r.source === 'onprem.html').componentId;
    await writeFile(path.join(options.inputDir, 'assets', 'app.102.js'), 'console.log("new build");');
    const changed = await packageNativeSolution(options);
    assert.equal(changed.resources.find((r) => r.source === 'onprem.html').componentId, entryId);
    assert.notDeepEqual(await readFile(options.outputZip), firstZip);
    assert.equal(first.resources.find((r) => r.source === 'assets/app.102.js').componentId,
      changed.resources.find((r) => r.source === 'assets/app.102.js').componentId);
  });
});

test('CLI ZIP bytes and DOS timestamps are deterministic across distinct process time zones', async () => {
  await withFixture(async (options, dir) => {
    const zones = ['UTC', 'America/New_York', 'Asia/Tokyo'];
    const outputs = [];
    for (const [index, tz] of zones.entries()) {
      const env = { ...process.env, TZ: tz };
      const localMidnight = spawnSync(process.execPath,
        ['-e', 'process.stdout.write(new Date(1980, 0, 1).toISOString())'],
        { env, encoding: 'utf8' });
      assert.equal(localMidnight.status, 0, `${tz}: ${localMidnight.stderr}`);

      const zipPath = path.join(dir, `zone-${index}.zip`);
      const manifestPath = path.join(dir, `zone-${index}.json`);
      const run = spawnSync(process.execPath,
        [scriptPath, '--input', options.inputDir, '--output', zipPath, '--manifest', manifestPath,
          '--publisher-prefix', options.publisherPrefix, '--publisher-unique-name', options.publisherUniqueName,
          '--option-value-prefix', String(options.publisherOptionValuePrefix), '--version', options.version],
        { env, encoding: 'utf8' });
      assert.equal(run.status, 0, `${tz}: ${run.stderr}`);

      const zip = await readFile(zipPath);
      outputs.push({
        tz,
        localMidnight: localMidnight.stdout,
        zip,
        sha256: createHash('sha256').update(zip).digest('hex'),
        manifest: await readFile(manifestPath),
      });
    }
    assert.equal(new Set(outputs.map((item) => item.localMidnight)).size, zones.length,
      'Timezone child processes must actually observe different local clocks.');
    for (const output of outputs.slice(1)) {
      assert.deepEqual(output.zip, outputs[0].zip,
        `Byte-level ZIP differs for ${output.tz}: UTC=${outputs[0].sha256} versus ${output.sha256}`);
      assert.deepEqual(output.manifest, outputs[0].manifest,
        `Asset manifest differs for ${output.tz}.`);
    }

    // ZIP's MS-DOS timestamp is explicitly local wall-clock midnight on 1980-01-01,
    // not an epoch instant whose year/date change with the packager's local TZ.
    const view = new DataView(outputs[0].zip.buffer, outputs[0].zip.byteOffset, outputs[0].zip.byteLength);
    assert.equal(view.getUint32(0, true), 0x04034b50, 'First ZIP entry local header');
    assert.equal(view.getUint16(10, true), 0, 'DOS local modification time: 00:00:00');
    assert.equal(view.getUint16(12, true), 0x0021, 'DOS local modification date: 1980-01-01');
  });
});

test('metadata structure matches a sanitized disposable v9.1 exported webresource solution', async () => {
  await withFixture(async (options) => {
    await packageNativeSolution(options);
    const zip = unzipSync(await readFile(options.outputZip));
    const customizations = zipText(zip, 'customizations.xml');
    const contentTypes = zipText(zip, '[Content_Types].xml');
    const solution = zipText(zip, 'solution.xml');
    const rootChildren = [...customizations.matchAll(/^  <([A-Za-z]+)(?:\s*\/>|>)/gm)].map((m) => m[1]);
    assert.deepEqual(rootChildren, observedV91Format.customizationsRootNodesInOrder);
    const firstWebResource = /<WebResource>([\s\S]*?)<\/WebResource>/.exec(customizations);
    assert.ok(firstWebResource);
    const fields = [...firstWebResource[1].matchAll(/^      <([A-Za-z]+)(?:\s*\/>|>)/gm)].map((m) => m[1]);
    assert.deepEqual(fields, observedV91Format.webResourceFieldsInOrder);
    assert.match(solution, /<RootComponent type="61" schemaName="mxrm_\/commandbarstudio\/onprem\.html" behavior="0"/);
    assert.match(contentTypes, /<Default Extension="xml" ContentType="application\/octet-stream"/);
    const example = observedV91Format.webResourcePathExample;
    assert.equal(`WebResources/${example.logicalName.replace(/[/.]/g, '')}${example.componentId.toUpperCase()}`, example.zipPart);
  });
});

test('rejects path traversal, windows paths and case-insensitive resource name collisions', () => {
  for (const invalid of ['../escape.js', 'assets/../../escape.js', '/absolute.js', 'C:/drive.js', 'assets\\foo.js', 'assets//foo.js']) {
    assert.throws(() => validateAssetPaths([invalid], 'mxrm'), /path|traversal|invalid|absolute/i, invalid);
  }
  assert.throws(() => validateAssetPaths(['assets/Foo.js', 'assets/foo.js'], 'mxrm'), /collision|duplicate/i);
  assert.throws(() => validateAssetPaths(['assets/Sub/a.js', 'assets/sub/A.js'], 'mxrm'), /collision|duplicate/i);
});

test('rejects unsupported resource extensions, oversized files and hidden output files', async () => {
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'assets', 'unsupported.json'), '{}');
    await assert.rejects(() => packageNativeSolution(options), /unsupported|\.json/i);
  });
  await withFixture(async (options) => {
    options.maxFileBytes = 10;
    await assert.rejects(() => packageNativeSolution(options), /exceeds|maximum|size|10 bytes/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, '.hidden'), 'something');
    await assert.rejects(() => packageNativeSolution(options), /unsupported|invalid|hidden/i);
  });
});

test('rejects broken relative references and missing or incorrectly rooted global context', async () => {
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'onprem.html'), fixtureFiles['onprem.html'].replace('./assets/app.102.js', './assets/missing.js'));
    await assert.rejects(() => packageNativeSolution(options), /missing|reference/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'onprem.html'), fixtureFiles['onprem.html'].replace(contextSrc, '/WebResources/ClientGlobalContext.js.aspx'));
    await assert.rejects(() => packageNativeSolution(options), /ClientGlobalContext|context|absolute/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'onprem.html'), fixtureFiles['onprem.html'].replace(contextSrc, 'https://some-cdn.example/context.js'));
    await assert.rejects(() => packageNativeSolution(options), /external|CDN|ClientGlobalContext|context/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'assets', 'app.102.css'), 'p { background: url(./not-built.png) }');
    await assert.rejects(() => packageNativeSolution(options), /missing|reference/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'assets', 'app.102.js'), 'import("/assets/lazy.103.js")');
    await assert.rejects(() => packageNativeSolution(options), /absolute|external|root/i);
  });
  await withFixture(async (options) => {
    await writeFile(path.join(options.inputDir, 'assets', 'app.102.js'), 'import("./not-built.js")');
    await assert.rejects(() => packageNativeSolution(options), /missing|reference/i);
  });
});

test('ignores Monaco-style grammar text, comments and regex literals that only resemble imports', async () => {
  const syntaxGrammar = String.raw`
    const syntax = {
      from: 'from "./not-a-module.js"',
      importCall: "import('./not-a-module.js')",
      url: 'new URL("./not-a-module.js", import.meta.url)',
      scripts: 'importScripts("./not-a-module.js")',
      tokens: /import\(\s*["']\.\/not-a-module\.js["']\s*\)/,
    };
    // import('./not-a-module.js'); export * from './not-a-module.js';
    /* new Worker(new URL('./not-a-module.js', import.meta.url)) */
    export default syntax;
  `;
  await withFixture(async (options) => {
    const result = await packageNativeSolution({ ...options, dryRun: true });
    assert.equal(result.resources.length, 5);
  }, { 'assets/app.102.js': syntaxGrammar });
});

test('extracts real ESM imports, re-exports and dynamic imports instead of similar strings', async () => {
  for (const source of [
    'import "./not-built.js";',
    'import thing from "./not-built.js"; console.log(thing);',
    'export * from "./not-built.js";',
    'export { thing } from "./not-built.js";',
    'const module = import(/* comment */ "./not-built.js");',
    'importScripts("./not-built.js");',
  ]) {
    await withFixture(async (options) => {
      await assert.rejects(() => packageNativeSolution({ ...options, dryRun: true }),
        /Missing or escaping asset reference.*not-built\.js/i, source);
    }, { 'assets/app.102.js': source });
  }

  const realReferences = `
    import "./lazy.103.js";
    export { default as lazy } from "./lazy.103.js";
    void import(/* vite chunk */ "./lazy.103.js");
    importScripts("./lazy.103.js");
    const worker = new Worker(new URL("./lazy.103.js", import.meta.url), { type: "module" });
  `;
  await withFixture(async (options) => {
    const result = await packageNativeSolution({ ...options, dryRun: true });
    assert.equal(result.resources.length, 5);
  }, { 'assets/app.102.js': realReferences });
});

test('rejects missing/external/traversing real Worker and import.meta.url assets', async () => {
  for (const [source, reason] of [
    ['new Worker(new URL("./not-built.js", import.meta.url), { type: "module" });', /Missing or escaping asset reference.*not-built\.js/i],
    ['new SharedWorker("./not-built.js");', /Missing or escaping asset reference.*not-built\.js/i],
    ['new URL("/assets/not-built.js", import.meta.url);', /Absolute or external asset reference/i],
    ['new Worker(new URL("https://cdn.example.org/worker.js", import.meta.url));', /Absolute or external asset reference/i],
    ['import("../../../outside.js");', /Missing or escaping asset reference/i],
  ]) {
    await withFixture(async (options) => {
      await assert.rejects(() => packageNativeSolution({ ...options, dryRun: true }), reason, source);
    }, { 'assets/app.102.js': source });
  }
});

test('validates publisher and solution identity, version and positive upload limit', async () => {
  const invalid = [
    [{ publisherPrefix: '1bad' }, /prefix/i],
    [{ publisherPrefix: 'toolongprefix' }, /prefix/i],
    [{ publisherPrefix: 'mscrm' }, /prefix/i],
    [{ publisherOptionValuePrefix: 9999 }, /option|prefix/i],
    [{ publisherOptionValuePrefix: 100000 }, /option|prefix/i],
    [{ solutionUniqueName: '../bad' }, /solution|name|identity/i],
    [{ publisherUniqueName: '<script>' }, /publisher|name|identity/i],
    [{ version: 'today' }, /version/i],
    [{ maxFileBytes: 0 }, /size|limit|positive|bytes/i],
  ];
  await withFixture(async (options) => {
    for (const [change, message] of invalid) {
      await assert.rejects(() => packageNativeSolution({ ...options, ...change }), message);
    }
  });
});

test('dry run enumerates every resource and sizes without writing output', async () => {
  await withFixture(async (options) => {
    const result = await packageNativeSolution({ ...options, dryRun: true });
    assert.equal(result.resources.length, 5);
    assert.equal(result.totalBytes, Object.values(fixtureFiles).reduce((sum, text) => sum + Buffer.byteLength(text), 0));
    assert.ok(result.largestResource.bytes > 0);
    await assert.rejects(() => stat(options.outputZip), { code: 'ENOENT' });
    await assert.rejects(() => stat(options.manifestPath), { code: 'ENOENT' });
  });
});

test('CLI dry-run accepts explicit identity and prints the complete resource report', async () => {
  await withFixture(async (options) => {
    const cmd = spawnSync(process.execPath, [scriptPath, '--input', options.inputDir, '--output', options.outputZip,
      '--manifest', options.manifestPath, '--publisher-prefix', options.publisherPrefix,
      '--publisher-unique-name', options.publisherUniqueName, '--publisher-display-name', options.publisherDisplayName,
      '--option-value-prefix', String(options.publisherOptionValuePrefix),
      '--solution-unique-name', options.solutionUniqueName, '--solution-display-name', options.solutionDisplayName,
      '--version', options.version, '--max-file-bytes', String(options.maxFileBytes), '--dry-run'], { encoding: 'utf8' });
    assert.equal(cmd.status, 0, cmd.stderr);
    assert.match(cmd.stdout, /mxrm_\/commandbarstudio\/onprem\.html/);
    assert.match(cmd.stdout, /assets\/lazy\.103\.js/);
    assert.match(cmd.stdout, /largest|total/i);
    await assert.rejects(() => stat(options.outputZip), { code: 'ENOENT' });
  });
});
