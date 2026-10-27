#!/usr/bin/env node
/**
 * Automatically increments the patch version (e.g. 0.1.0 -> 0.1.1) and Android
 * `versionCode` across the monorepo whenever an Android APK is packaged (or when
 * invoked directly with `node scripts/bump-version.mjs [explicitVersion]`).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function bumpPatch(version) {
  const parts = version.trim().split('.').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
  return `${parts[0]}.${parts[1]}.${parts[2] + 1}`;
}

const rootPkgPath = resolve(rootDir, 'package.json');
const rootPkg = JSON.parse(readFileSync(rootPkgPath, 'utf8'));
const oldVersion = rootPkg.version;
const explicitVersion = process.argv[2];
const nextVersion = explicitVersion && !explicitVersion.startsWith('-') ? explicitVersion : bumpPatch(oldVersion);

const pkgPaths = [
  'package.json',
  'packages/core/package.json',
  'packages/ui/package.json',
  'packages/host-node/package.json',
  'packages/host-android/package.json',
];

for (const rel of pkgPaths) {
  const full = resolve(rootDir, rel);
  const pkg = JSON.parse(readFileSync(full, 'utf8'));
  pkg.version = nextVersion;
  writeFileSync(full, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
}

const serverContextPath = resolve(rootDir, 'packages/host-node/src/server/context.ts');
const serverContext = readFileSync(serverContextPath, 'utf8');
writeFileSync(
  serverContextPath,
  serverContext.replace(/export const KOTORI_VERSION = '[^']+';/, `export const KOTORI_VERSION = '${nextVersion}';`),
  'utf8',
);

const androidDepsPath = resolve(rootDir, 'packages/host-android/src/default-deps.ts');
const androidDeps = readFileSync(androidDepsPath, 'utf8');
writeFileSync(
  androidDepsPath,
  androidDeps.replace(/version = '[0-9]+\.[0-9]+\.[0-9]+';/, `version = '${nextVersion}';`),
  'utf8',
);

const gradlePath = resolve(rootDir, 'packages/host-android/android/app/build.gradle');
const gradle = readFileSync(gradlePath, 'utf8');
let nextVersionCode = 1;
const updatedGradle = gradle
  .replace(/versionCode\s+(\d+)/, (_m, code) => {
    nextVersionCode = Number(code) + 1;
    return `versionCode ${nextVersionCode}`;
  })
  .replace(/versionName\s+"[^"]+"/, `versionName "${nextVersion}"`);
writeFileSync(gradlePath, updatedGradle, 'utf8');

console.log(`[bump-version] ${oldVersion} -> ${nextVersion} (Android versionCode ${nextVersionCode})`);
